// Gmail OAuth + API integration types

/** OAuth state parameter passed through Google redirect, validated on callback */
export interface GmailOAuthState {
  readonly userId: string;
  readonly phone: string; // E.164 NZ mobile
  readonly nonce: string; // CSRF protection
}

/** Token response from Google's OAuth token endpoint */
export interface GoogleTokenResponse {
  readonly access_token: string;
  readonly expires_in: number; // seconds (typically 3600)
  readonly refresh_token?: string; // only on first authorization
  readonly scope: string;
  readonly token_type: 'Bearer';
}

/** Decrypted token pair used in-memory during email polling */
export interface DecryptedGmailTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiry: string; // ISO 8601 absolute
}

/** Gmail API message list response (partial) */
export interface GmailMessageList {
  readonly messages?: ReadonlyArray<{ readonly id: string }>;
  readonly nextPageToken?: string;
  readonly resultSizeEstimate: number;
}

/** A single MIME part. Recursive: a multipart/* part nests child `parts`. */
export interface GmailMessagePart {
  readonly mimeType: string;
  readonly filename: string;
  readonly body: { readonly attachmentId?: string; readonly size: number };
  readonly partId: string;
  /** Child parts for multipart/* containers (Issue #227 fix 2 — recursive walk). */
  readonly parts?: ReadonlyArray<GmailMessagePart>;
  /** Headers may appear on nested parts as well as the top-level payload. */
  readonly headers?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

/** Gmail API message detail with attachment metadata */
export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly payload?: {
    readonly headers: ReadonlyArray<{
      readonly name: string;
      readonly value: string;
    }>;
    readonly parts?: ReadonlyArray<GmailMessagePart>;
    readonly mimeType: string;
  };
  readonly internalDate: string;
}

/** Result of scanning one user's Gmail inbox */
export interface PollResult {
  readonly userId: string;
  readonly billsFound: number;
  readonly errors: ReadonlyArray<string>;
}

/** Gmail search query criteria */
export interface GmailSearchCriteria {
  readonly fromDomains: ReadonlyArray<string>;
  readonly hasAttachment: boolean;
  readonly after?: string; // ISO date for incremental polling
}

/** Progress snapshot written to KV during a Gmail scan. Mutable — built up during scanning. */
export interface ScanProgress {
  phase: 'connecting' | 'searching' | 'scanning' | 'complete';
  searchQuery?: string;
  messagesFound: number;
  messagesScanned: number;
  messagesSkippedNoSubject: number;
  messagesSkippedNoPdf: number;
  billsFound: number;
  /** From addresses that yielded at least one bill */
  billSenders: string[];
  /** From addresses matched by Gmail search but excluded by subject/PDF filters */
  filteredSenders: string[];
  errors: string[];
  complete: boolean;
  startedAt: string; // ISO 8601
  finishedAt?: string; // ISO 8601
}
