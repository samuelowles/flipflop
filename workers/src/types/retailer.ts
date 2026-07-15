export interface Retailer {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly emailDomains: readonly string[];
  readonly parserId: string | null;
  readonly isActive: boolean;
}
