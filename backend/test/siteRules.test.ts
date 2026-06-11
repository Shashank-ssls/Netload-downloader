import { describe, it, expect } from 'vitest';
import { ruleMatches, matchRule, buildRuleArgs, sanitizeRules, type SiteRule } from '../src/providers/siteRules';
import { RulesProvider } from '../src/providers/rulesProvider';

const rule = (over: Partial<SiteRule> = {}): SiteRule => ({ match: ['examplestream.tv'], ...over });

describe('ruleMatches / matchRule', () => {
  it('matches when any substring is in the URL', () => {
    expect(ruleMatches(rule({ match: ['a.tv', 'b.tv'] }), 'https://b.tv/watch/1')).toBe(true);
    expect(ruleMatches(rule({ match: ['a.tv'] }), 'https://other.tv/1')).toBe(false);
  });

  it('returns the first matching rule', () => {
    const rules = [rule({ name: 'one', match: ['one.tv'] }), rule({ name: 'two', match: ['two.tv'] })];
    expect(matchRule(rules, 'https://two.tv/x')?.name).toBe('two');
    expect(matchRule(rules, 'https://zzz.tv/x')).toBeNull();
  });
});

describe('buildRuleArgs', () => {
  it('expands every knob into yt-dlp args', () => {
    const args = buildRuleArgs(rule({
      extractorArgs: ['generic:impersonate'],
      hlsNative: true,
      socketTimeout: 30,
      referer: 'https://ref.example',
      headers: { Origin: 'https://o.example' },
    }), 'https://examplestream.tv/v/1');
    expect(args).toEqual([
      '--extractor-args', 'generic:impersonate',
      '--hls-prefer-native', '--hls-use-mpegts',
      '--socket-timeout', '30',
      '--referer', 'https://ref.example',
      '--add-header', 'Origin:https://o.example',
    ]);
  });

  it("resolves referer 'self' to the URL origin", () => {
    const args = buildRuleArgs(rule({ referer: 'self' }), 'https://examplestream.tv/v/1?t=2');
    expect(args).toEqual(['--referer', 'https://examplestream.tv']);
  });

  it('produces no args for a bare rule', () => {
    expect(buildRuleArgs(rule(), 'https://examplestream.tv/x')).toEqual([]);
  });
});

describe('sanitizeRules', () => {
  it('accepts a bare array and a {rules:[]} wrapper', () => {
    expect(sanitizeRules([rule()]).length).toBe(1);
    expect(sanitizeRules({ rules: [rule()] }).length).toBe(1);
  });

  it('drops entries without a non-empty match array (e.g. a _note)', () => {
    expect(sanitizeRules({ _note: 'hi', rules: [{ match: [] }, { name: 'x' } as any, rule()] }).length).toBe(1);
    expect(sanitizeRules('garbage')).toEqual([]);
  });
});

describe('RulesProvider', () => {
  it('adapts a rule into a BaseProvider', () => {
    const p = new RulesProvider(rule({ name: 'host', impersonate: 'chrome', format: 'best' }));
    expect(p.name).toBe('host');
    expect(p.match('https://examplestream.tv/x')).toBe(true);
    expect(p.getImpersonateTarget()).toBe('chrome');
    expect(p.getFormatStrategy()).toBe('best');
  });

  it('defaults name + format when omitted', () => {
    const p = new RulesProvider(rule());
    expect(p.name).toBe('rule:examplestream.tv');
    expect(p.getFormatStrategy()).toBe('bestvideo+bestaudio/best');
    expect(p.getImpersonateTarget()).toBeNull();
  });
});
