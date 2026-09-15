const ACCESS_TOKEN = /^fqo_at_([0-9a-f]{24})_[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_FRAGMENT = /fqo_at_[0-9a-f]{24}_[A-Za-z0-9_-]{43}/;

export function oauthAccessTokenSelector(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length !== 75) return undefined;
  return ACCESS_TOKEN.exec(value)?.[1];
}

export function containsOAuthAccessToken(value: unknown): boolean {
  return typeof value === 'string' && ACCESS_TOKEN_FRAGMENT.test(value);
}
