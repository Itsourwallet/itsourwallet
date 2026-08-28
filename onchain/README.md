# It's Our Wallet on-chain program

Status: **pre-audit and not approved for mainnet deployment or deposits**.

Implemented in the current security milestone:

- Global treasury PDA and deterministic round PDA
- 30-second rounds using the Solana Clock sysvar
- Paid proposal and voting fees transferred directly to the treasury PDA
- One auditable vote receipt per wallet/proposal with multi-vote purchases
- Checked arithmetic and deterministic winner/tie selection
- Permissionless, duplicate-resistant round settlement
- Hard safety ceilings and emergency pause controls
- Typed action enum without an arbitrary-call escape hatch

Not yet implemented and therefore blocking production readiness:

- On-chain allowlist accounts and timelocked multisig configuration
- Oracle-valued 25% action limit and rolling 24-hour limits
- Typed CPI execution for tokens, Jupiter and approved protocols
- Token-2022 validation and complete remaining-account validation
- Keeper rewards, next-round creation and failed-execution recording
- Dynamic congestion fees and full boundary/property tests
- Independent audit and reproducible mainnet build

The deployer and program keypairs are intentionally excluded from Git.
