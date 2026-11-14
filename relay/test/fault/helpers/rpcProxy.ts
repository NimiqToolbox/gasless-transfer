// A fault-injecting JSON-RPC proxy between the relay and anvil. Every call is forwarded unless a
// rule decides otherwise: answer with a fabricated result or error, fail at the HTTP level, hang until the
// client times out, reset the connection, or rewrite the upstream answer (a lying node). Everything runs on
// 127.0.0.1 inside the test container.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface JsonRpcCall {
    readonly jsonrpc?: string;
    readonly id: number | string | null;
    readonly method: string;
    readonly params?: readonly unknown[];
}

export type RpcAnswer =
    | { readonly result: unknown; readonly error?: undefined }
    | { readonly error: { code: number; message: string; data?: unknown }; readonly result?: undefined };

export type Action =
    | { readonly kind: 'forward' }
    | { readonly kind: 'answer'; readonly answer: RpcAnswer }
    | { readonly kind: 'http'; readonly status: number }
    | { readonly kind: 'hang' }
    | { readonly kind: 'reset' };

export interface Rule {
    readonly name: string;
    match(call: JsonRpcCall): boolean;
    /** Decides before forwarding (default: forward). */
    before?(call: JsonRpcCall): Action | Promise<Action>;
    /** Rewrites the upstream answer of a forwarded call. */
    after?(call: JsonRpcCall, answer: RpcAnswer): RpcAnswer | Promise<RpcAnswer>;
    /** Remaining applications; undefined = unlimited. */
    times?: number;
}

export interface CallRecord {
    readonly method: string;
    readonly params: readonly unknown[];
    readonly rule: string | undefined;
    readonly atMs: number;
}

export const FORWARD: Action = { kind: 'forward' };

export class RpcProxy {
    readonly calls: CallRecord[] = [];
    private rules: Rule[] = [];
    private server: Server | undefined;
    private readonly sockets = new Set<Socket>();
    private readonly hanging = new Set<ServerResponse>();
    url = '';

    constructor(private readonly upstream: string) {}

    async start(): Promise<this> {
        this.server = createServer((req, res) => void this.handle(req, res));
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.server.listen(0, '127.0.0.1');
        await once(this.server, 'listening');
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        return this;
    }

    /** Adds a rule; the first matching active rule wins. Returns a function that removes it. */
    add(rule: Rule): () => void {
        this.rules.push(rule);
        return () => this.remove(rule.name);
    }

    remove(name: string): void {
        this.rules = this.rules.filter((r) => r.name !== name);
    }

    clear(): void {
        this.rules = [];
        for (const res of this.hanging) res.destroy();
        this.hanging.clear();
    }

    /** Raw transactions the relay tried to broadcast, in order. */
    rawTransactions(): string[] {
        return this.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => String(c.params[0]));
    }

    count(method: string): number {
        return this.calls.filter((c) => c.method === method).length;
    }

    async stop(): Promise<void> {
        this.clear();
        for (const s of this.sockets) s.destroy();
        if (this.server) {
            this.server.close();
            await once(this.server, 'close').catch(() => undefined);
        }
    }

    /** Sends one JSON-RPC call straight to anvil (for the tests' own reads and anvil_* control calls). */
    async upstreamCall(method: string, params: readonly unknown[] = []): Promise<unknown> {
        const answer = await this.forward({ jsonrpc: '2.0', id: 1, method, params });
        if (answer.error) throw new Error(`${method}: ${answer.error.message}`);
        return answer.result;
    }

    private async forward(call: JsonRpcCall): Promise<RpcAnswer> {
        const res = await fetch(this.upstream, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params ?? [] }),
        });
        const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        return json.error ? { error: json.error } : { result: json.result ?? null };
    }

    private pick(call: JsonRpcCall): Rule | undefined {
        for (const rule of this.rules) {
            if (rule.times !== undefined && rule.times <= 0) continue;
            if (rule.match(call)) {
                if (rule.times !== undefined) rule.times -= 1;
                return rule;
            }
        }
        return undefined;
    }

    private async process(call: JsonRpcCall): Promise<{ action: Action; answer?: RpcAnswer }> {
        const rule = this.pick(call);
        this.calls.push({ method: call.method, params: call.params ?? [], rule: rule?.name, atMs: Date.now() });
        const action = rule?.before ? await rule.before(call) : FORWARD;
        if (action.kind === 'answer') return { action, answer: action.answer };
        if (action.kind !== 'forward') return { action };
        let answer = await this.forward(call);
        if (rule?.after) answer = await rule.after(call, answer);
        return { action, answer };
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
            res.writeHead(400).end();
            return;
        }
        const batch = Array.isArray(body);
        const calls = (batch ? body : [body]) as JsonRpcCall[];
        const out: Array<Record<string, unknown>> = [];
        for (const call of calls) {
            let processed: { action: Action; answer?: RpcAnswer };
            try {
                processed = await this.process(call);
            } catch (err) {
                processed = { action: FORWARD, answer: { error: { code: -32603, message: `proxy: ${String(err)}` } } };
            }
            const { action, answer } = processed;
            if (action.kind === 'hang') {
                this.hanging.add(res);
                res.on('close', () => this.hanging.delete(res));
                return;
            }
            if (action.kind === 'reset') {
                req.socket.destroy();
                return;
            }
            if (action.kind === 'http') {
                res.writeHead(action.status, { 'content-type': 'text/plain' }).end('proxy: injected HTTP failure');
                return;
            }
            out.push({ jsonrpc: '2.0', id: call.id, ...(answer?.error ? { error: answer.error } : { result: answer?.result ?? null }) });
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? out : out[0]));
    }
}

/** Matches a method, optionally with a predicate on the parameters. */
export function method(name: string, predicate?: (params: readonly unknown[]) => boolean): (call: JsonRpcCall) => boolean {
    return (call) => call.method === name && (predicate ? predicate(call.params ?? []) : true);
}
