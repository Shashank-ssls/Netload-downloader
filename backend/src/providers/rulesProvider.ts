import { BaseProvider, ProviderCapabilities } from './base';
import { SiteRule, buildRuleArgs, ruleMatches } from './siteRules';

/**
 * A BaseProvider materialised from a declarative {@link SiteRule}. Lets the
 * detector treat a data-row rule exactly like a hand-written provider, so a new
 * site can be onboarded without code (roadmap A1).
 */
export class RulesProvider extends BaseProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private readonly rule: SiteRule) {
    super();
    this.name = rule.name || `rule:${rule.match[0]}`;
    this.capabilities = {
      supportsCookies: true,
      supportsM3U8: true,
      requiresReferer: !!rule.referer,
      requiresImpersonation: !!rule.impersonate,
      retryStrategy: 'exponential',
    };
  }

  match(url: string): boolean {
    return ruleMatches(this.rule, url);
  }

  getSpecificArgs(url: string): string[] {
    return buildRuleArgs(this.rule, url);
  }

  getImpersonateTarget(): string | null {
    return this.rule.impersonate ?? null;
  }

  getFormatStrategy(): string {
    return this.rule.format || 'bestvideo+bestaudio/best';
  }
}
