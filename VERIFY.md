# It's Our Wallet: Mainnet Verification

This repository is the official organization source for the Solana program deployed at:

    G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8

Public deployment facts:

- Network: Solana mainnet-beta
- ProgramData: J4q4HrGWZjThw98sMb38jSLXNHhnRMoHZMMmKGrPm1wJ
- Deployment slot: 442381141
- Deployment transaction: PuTiUheGCVYfnw2UdK3hkVp6VYh9KAuTBAmdCDVp2cDgdD6QU7WQwC9wsKUFvocCkHm8xLGG6eiUXiqtRpExAoJ
- Release binary SHA-256: 2c138135abfe7ece4d652d7948aa110e287b6a06273ed2d16ddc712f6e6250fb

## Quick public check

Open the program and deployment transaction:

- https://explorer.solana.com/address/G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8
- https://solscan.io/tx/PuTiUheGCVYfnw2UdK3hkVp6VYh9KAuTBAmdCDVp2cDgdD6QU7WQwC9wsKUFvocCkHm8xLGG6eiUXiqtRpExAoJ

Using Solana CLI:

    solana program show G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8 --url mainnet-beta
    solana program dump G2EYJC2fg2eH5sGw1Fr3Sk4bXqPSvQ4NVcX1BmGFzVA8 deployed.so --url mainnet-beta

The deployed account is 364,048 bytes. The published release binary is 361,760 bytes. During release verification, the first 361,760 deployed bytes matched the release binary exactly and every remaining byte was zero padding.

## Rebuild from source

Install the pinned Rust, Solana and Anchor toolchains documented by the project, then run:

    cd onchain
    anchor build --no-idl
    sha256sum target/deploy/onchain.so

A source rebuild can differ when compiler or dependency versions differ. Matching source and a published hash are evidence of deployment provenance; they are not a security audit.

## Trust disclosure

