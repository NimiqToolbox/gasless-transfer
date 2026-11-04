# Polygon deployment

GaslessTransfer, EIP-712 domain version `3`, built from this repository's `contracts/src`. Records: [contracts/deployments/137.json](../../contracts/deployments/137.json) and [contracts/deployments/80002.json](../../contracts/deployments/80002.json).

| Field | Polygon PoS (137) | Polygon Amoy (80002) |
| --- | --- | --- |
| GaslessTransfer | `0x5A3a650fCf35639153aA6bA9aa3e870DAED56199` | `0xe5D40efb4a89F6D3aDd07D8881F4b372f02c8075` |
| Deployment transaction | `0x5e1851e9598de5b08f62f73bcbaee5e0b6f5eb7733aebfd3f62db0ee02bda14d` | `0x37c8fa65a34305bfc3e6ac4b83ec78da5b96b91b13eb1236732e465080553294` |
| Deployment block | 95,893,593 | 51,892,090 |
| Constructor owner | `0x682c578E5f07E6A742Fa5C681507c785d3f32256` | `0x6465e47837DB340D8Ac465E2F58cD6c08b275965` |
| Current owner | `0x6465e47837DB340D8Ac465E2F58cD6c08b275965` since block 96,722,258 | `0x6465e47837DB340D8Ac465E2F58cD6c08b275965` |
| keccak256 of the creation code (without arguments) | `0xf844f13c63786420b8c5142b898ed634e5ab330027b32ec2e198ba25005aa6ed` | same |
| keccak256 of the deployment transaction input (creation code and constructor arguments) | `0xc67cedb3cc2d3b8f6b9401755d42144854c798b8e0c17446eed1d60e30e0c4e1` | `0x34a3b2d20ccf2bd7e607796a855918e87fabfc58c8778bb8959ef648652207ec` |
| keccak256 of the runtime code | `0x8637b384103bf3468d6509a3529f190ce34f9ac48f521f01f6a4daa6e2388b21` | `0x42400c9c6f7f8a9d3c8f424484524de779fe36cc6ee18ae82540f234ae5c5cb3` |
| Transfer domain separator | `0x036cd5f7684d421a11ff62ffdd91308769a47e6fe620935caeba61c872d828de` | `0xed1217efe85143e718fc9f59d3cffb6a27f3d671bf2c3a70435f0efc6301a5d7` |

The token configuration of both deployments is in the records: on Polygon PoS native USDC (permit, existing allowance) and USDT0 (permit, meta-transaction approval, existing allowance); on Amoy Circle's test USDC and a [mock USDT0](../../contracts/test/mocks/MockUSDT0.sol) with the same modes.

## Reproducing the deployed bytecode

The runtime codes of the two deployments differ only in their immutables (`address(this)`, the chain ID and the cached domain separator). The check below therefore compares the creation input: each deployment transaction's input must be the locally built creation code followed by the constructor arguments of its record, and its receipt must show that it created the contract.

Run it from the root of a checkout with Foundry 1.8.3 and git. `POLYGON_RPC_URL` and `AMOY_RPC_URL` are any RPC endpoints of the two chains; nothing is sent.

```sh
cd contracts
git -c advice.detachedHead=false clone -q --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git -c advice.detachedHead=false clone -q --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
[ "$(git -C lib/openzeppelin-contracts rev-parse HEAD)" = 5fd1781b1454fd1ef8e722282f86f9293cacf256 ] && echo "openzeppelin-contracts v5.6.1: OK" || echo "openzeppelin-contracts: COMMIT MISMATCH"
[ "$(git -C lib/forge-std rev-parse HEAD)" = bf647bd6046f2f7da30d0c2bf435e5c76a780c1b ] && echo "forge-std v1.16.2: OK" || echo "forge-std: COMMIT MISMATCH"
forge build

# $1 RPC URL, $2 chain id, $3 contract address, $4 deployment transaction
verify_deployment() {
  code=$(forge inspect GaslessTransfer bytecode)
  input=$(cast tx "$4" input --rpc-url "$1")
  [ "$(cast chain-id --rpc-url "$1")" = "$2" ] && echo "chain id $2: OK" || echo "chain id: MISMATCH"
  [ "$(cast receipt "$4" contractAddress --rpc-url "$1")" = "$3" ] && echo "tx created $3: OK" || echo "created address: MISMATCH"
  case "$input" in "$code"*) echo "tx input = local creation code + args: OK" ;; *) echo "creation code: MISMATCH" ;; esac
  echo "constructor args (compare with deployments/$2.json):"
  cast abi-decode --input "constructor(address,(address,(bool,bool,bool))[])" "0x${input#"$code"}"
  echo "keccak256 creation code:         $(cast keccak "$code")"
  echo "keccak256 tx input (code + args): $(cast keccak "$input")"
  echo "keccak256 runtime code:          $(cast keccak "$(cast code "$3" --rpc-url "$1")")"
}
verify_deployment "$POLYGON_RPC_URL" 137 0x5A3a650fCf35639153aA6bA9aa3e870DAED56199 0x5e1851e9598de5b08f62f73bcbaee5e0b6f5eb7733aebfd3f62db0ee02bda14d
verify_deployment "$AMOY_RPC_URL" 80002 0xe5D40efb4a89F6D3aDd07D8881F4b372f02c8075 0x37c8fa65a34305bfc3e6ac4b83ec78da5b96b91b13eb1236732e465080553294
```

Each deployment prints three OK lines, the decoded constructor arguments and the three hashes of the table. The token configuration tuples are `(permit, metaTxApprove, allowance)`; `allowance` is the record's auth mode `none`. The owner in the arguments is the constructor owner; ownership moves only through `transferOwnership` and `acceptOwnership` (§4.2 of the [protocol reference](../STEP-1-GAS-ABSTRACTION.md)).

`deployBlock` in the records is a lower bound for the deployment block, not the block itself.
