// Shared data model for the trade tools. A trade is a flat list of assets
// with destinations — not a set of pairwise swaps — so 2-team and 3-team
// deals run through identical grading code with no branching (Part 6).

export type AssetType = 'player' | 'pick';

export interface TradeAsset {
  assetId: string; // sleeperId for a player; `${season}_${round}_${originalRosterId}` for a pick
  assetType: AssetType;
  fromRosterId: number;
  toRosterId: number;
}

export interface Trade {
  assets: TradeAsset[];
}
