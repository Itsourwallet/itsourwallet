import { NextResponse } from 'next/server';

type DexToken = { address?: string; name?: string; symbol?: string };
type DexPair = {
  baseToken?: DexToken;
  quoteToken?: DexToken;
  priceUsd?: string | null;
  priceNative?: string | null;
  liquidity?: { usd?: number | null } | null;
};

type TokenPrice = { name?: string; symbol?: string; priceUsd?: number };

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { mints?: unknown };
  const mints = Array.isArray(body.mints)
    ? [...new Set(body.mints.filter((mint): mint is string => typeof mint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)))].slice(0, 90)
    : [];
  if (mints.length === 0) return NextResponse.json({ prices: {} });

  const prices: Record<string, TokenPrice> = {};
  for (let offset = 0; offset < mints.length; offset += 30) {
    const batch = mints.slice(offset, offset + 30);
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 20 },
    });
    if (!response.ok) continue;
    const pairs = await response.json() as DexPair[];
    const best = new Map<string, { liquidity: number; token: TokenPrice }>();
    for (const pair of pairs) {
      const basePrice = Number(pair.priceUsd);
      const nativePrice = Number(pair.priceNative);
      const liquidity = Number(pair.liquidity?.usd ?? 0);
      const candidates: Array<[DexToken | undefined, number]> = [
        [pair.baseToken, basePrice],
        [pair.quoteToken, basePrice > 0 && nativePrice > 0 ? basePrice / nativePrice : Number.NaN],
      ];
      for (const [token, priceUsd] of candidates) {
        if (!token?.address || !batch.includes(token.address) || !Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        if ((best.get(token.address)?.liquidity ?? -1) >= liquidity) continue;
        best.set(token.address, { liquidity, token: { name: token.name, symbol: token.symbol, priceUsd } });
      }
    }
    for (const [mint, result] of best) prices[mint] = result.token;
  }
  return NextResponse.json({ prices }, { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40' } });
}