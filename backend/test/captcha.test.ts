import { describe, it, expect } from 'vitest';
import { detectChallengeType, tokenFieldFor } from '../src/recovery/captcha';

describe('detectChallengeType', () => {
  it('detects hCaptcha', () => {
    expect(detectChallengeType('<div class="h-captcha" data-sitekey="x"></div>')).toBe('hcaptcha');
    expect(detectChallengeType('', ['https://hcaptcha.com/captcha/v1'])).toBe('hcaptcha');
  });

  it('detects reCAPTCHA', () => {
    expect(detectChallengeType('<div class="g-recaptcha"></div>')).toBe('recaptcha');
    expect(detectChallengeType('', ['https://www.google.com/recaptcha/api2/anchor'])).toBe('recaptcha');
  });

  it('detects Cloudflare Turnstile', () => {
    expect(detectChallengeType('<div class="cf-turnstile" data-sitekey="x"></div>')).toBe('turnstile');
    expect(detectChallengeType('', ['https://challenges.cloudflare.com/turnstile/v0/api.js'])).toBe('turnstile');
  });

  it('detects the plain Cloudflare JS challenge', () => {
    expect(detectChallengeType('<title>Just a moment...</title>')).toBe('cloudflare');
    expect(detectChallengeType('Checking your browser before accessing')).toBe('cloudflare');
  });

  it('returns null for an ordinary page', () => {
    expect(detectChallengeType('<html><body>hello</body></html>')).toBeNull();
  });

  it('prefers the specific widget over the generic CF text', () => {
    expect(detectChallengeType('Just a moment <div class="cf-turnstile"></div>')).toBe('turnstile');
  });
});

describe('tokenFieldFor', () => {
  it('maps each widget to its hidden response field', () => {
    expect(tokenFieldFor('turnstile')).toBe('cf-turnstile-response');
    expect(tokenFieldFor('hcaptcha')).toBe('h-captcha-response');
    expect(tokenFieldFor('recaptcha')).toBe('g-recaptcha-response');
  });

  it('has no token field for the plain CF JS challenge', () => {
    expect(tokenFieldFor('cloudflare')).toBeNull();
  });
});
