'use client';

import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { clusterApiUrl } from '@solana/web3.js';

export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl('mainnet-beta'), []);
  return <ConnectionProvider endpoint={endpoint}><WalletProvider wallets={[]} autoConnect><WalletModalProvider>{children}</WalletModalProvider></WalletProvider></ConnectionProvider>;
}
