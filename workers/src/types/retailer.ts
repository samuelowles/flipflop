export interface Retailer {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly parserId: string | null;
  readonly isActive: boolean;
}
