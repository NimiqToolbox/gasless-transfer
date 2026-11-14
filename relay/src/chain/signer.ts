import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/** Signs relay transactions. The private key stays inside the viem account closure. */
export interface TxSigner {
    readonly address: Address;
    signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

export function createLocalSigner(privateKey: Hex): TxSigner {
    const account = privateKeyToAccount(privateKey);
    return Object.freeze({
        address: account.address,
        signTransaction: (tx: TransactionSerializableEIP1559) => account.signTransaction(tx),
        toJSON: () => ({ address: account.address }),
    });
}
