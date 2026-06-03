export type OAuthProvider = 'gmail' | 'outlook';

export interface OAuthToken {
  readonly id: string;
  readonly userId: string;
  readonly provider: OAuthProvider;
  readonly accessTokenEncrypted: string;
  readonly refreshTokenEncrypted: string | null;
  readonly expiry: string; // ISO 8601
  readonly createdAt: string; // ISO 8601
}
