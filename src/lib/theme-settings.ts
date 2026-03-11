import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { site as legacySite } from '../../site.config.mjs';

export type SettingSource = 'new' | 'legacy' | 'default';

export type SidebarNavId = 'essay' | 'bits' | 'memo' | 'archive' | 'about';
export type PageId = 'essay' | 'archive' | 'bits' | 'memo' | 'about';
export type HeroPresetId = 'default' | 'minimal' | 'none';

export interface SidebarNavItem {
  id: SidebarNavId;
  label: string;
  visible: boolean;
  order: number;
}

export interface SiteFooterSettings {
  copyright: string;
}

export interface SiteSocialLinks {
  github: string | null;
  x: string | null;
  email: string | null;
  rss: boolean;
}

export interface SiteSettings {
  title: string;
  description: string;
  defaultLocale: string;
  footer: SiteFooterSettings;
  socialLinks: SiteSocialLinks;
}

export interface ShellSettings {
  brandTitle: string;
  quote: string;
  nav: SidebarNavItem[];
}

export interface HomeSettings {
  introLead: string;
  introMore: string;
  heroPresetId: HeroPresetId;
}

export interface PageSettingsItem {
  subtitle: string | null;
}

export interface BitsDefaultAuthorSettings {
  name: string;
  avatar: string;
}

export interface BitsPageSettings extends PageSettingsItem {
  defaultAuthor: BitsDefaultAuthorSettings;
}

export interface PageSettings {
  essay: PageSettingsItem;
  archive: PageSettingsItem;
  bits: BitsPageSettings;
  memo: PageSettingsItem;
  about: PageSettingsItem;
}

export interface UiSettings {
  codeBlock: {
    showLineNumbers: boolean;
  };
  readingMode: {
    showEntry: boolean;
  };
}

export interface ThemeSettings {
  site: SiteSettings;
  shell: ShellSettings;
  home: HomeSettings;
  page: PageSettings;
  ui: UiSettings;
}

export interface ThemeSettingsSources {
  site: {
    title: SettingSource;
    description: SettingSource;
    defaultLocale: SettingSource;
    footerCopyright: SettingSource;
    socialLinksGithub: SettingSource;
    socialLinksX: SettingSource;
    socialLinksEmail: SettingSource;
    socialLinksRss: SettingSource;
  };
  shell: {
    brandTitle: SettingSource;
    quote: SettingSource;
    nav: SettingSource;
  };
  home: {
    introLead: SettingSource;
    introMore: SettingSource;
    heroPresetId: SettingSource;
  };
  page: {
    essaySubtitle: SettingSource;
    archiveSubtitle: SettingSource;
    bitsSubtitle: SettingSource;
    bitsDefaultAuthorName: SettingSource;
    bitsDefaultAuthorAvatar: SettingSource;
    memoSubtitle: SettingSource;
    aboutSubtitle: SettingSource;
  };
  ui: {
    codeBlockShowLineNumbers: SettingSource;
    readingModeShowEntry: SettingSource;
  };
}

export interface ThemeSettingsResolved {
  settings: ThemeSettings;
  sources: ThemeSettingsSources;
}

const SETTINGS_DIR = join(process.cwd(), 'src', 'data', 'settings');

const LEGACY_INTRO_LEAD =
  '这是一个开源写作主题与示例内容库:包含 随笔/essay、小记/memo、归档/archive 与 絮语/bits，使用与配置请见 README 。';
const LEGACY_INTRO_MORE = '更多文章请访问';
const LEGACY_ESSAY_SUBTITLE = '随笔与杂记';
const LEGACY_BITS_SUBTITLE = '生活不只是长篇';
const LEGACY_QUOTE = 'A minimal Astro theme\nfor essays, notes, and docs.\nDesigned for reading,\nopen-source.';
const LEGACY_FOOTER_COPYRIGHT = 'Whono · Theme Demo · by cxro';
const LEGACY_SOCIAL_LINKS: SiteSocialLinks = {
  github: 'https://github.com/cxro/astro-whono',
  x: 'https://twitter.com/yourname',
  email: 'Whono@linux.do',
  rss: false
};
const LEGACY_NAV: SidebarNavItem[] = [
  { id: 'essay', label: '随笔', visible: true, order: 1 },
  { id: 'bits', label: '絮语', visible: true, order: 2 },
  { id: 'memo', label: '小记', visible: true, order: 3 },
  { id: 'archive', label: '归档', visible: true, order: 4 },
  { id: 'about', label: '关于', visible: true, order: 5 }
];

const cloneNavItems = (items: readonly SidebarNavItem[]): SidebarNavItem[] =>
  items.map((item) => ({ ...item }));

const DEFAULT_SITE: SiteSettings = {
  title: 'Whono',
  description: '一个 Astro 主题的展示站：轻量、可维护、可复用。',
  defaultLocale: 'zh-CN',
  footer: {
    copyright: LEGACY_FOOTER_COPYRIGHT
  },
  socialLinks: {
    github: null,
    x: null,
    email: null,
    rss: false
  }
};

const DEFAULT_SHELL: ShellSettings = {
  brandTitle: 'Whono',
  quote: LEGACY_QUOTE,
  nav: cloneNavItems(LEGACY_NAV)
};

const DEFAULT_HOME: HomeSettings = {
  introLead: LEGACY_INTRO_LEAD,
  introMore: LEGACY_INTRO_MORE,
  heroPresetId: 'default'
};

const DEFAULT_PAGE: PageSettings = {
  essay: {
    subtitle: LEGACY_ESSAY_SUBTITLE
  },
  archive: {
    subtitle: '按年份分组的归档目录'
  },
  bits: {
    subtitle: LEGACY_BITS_SUBTITLE,
    defaultAuthor: {
      name: 'Whono',
      avatar: 'author/avatar.webp'
    }
  },
  memo: {
    subtitle: null
  },
  about: {
    subtitle: null
  }
};

const HERO_PRESETS: ReadonlySet<HeroPresetId> = new Set(['default', 'minimal', 'none']);
const NAV_IDS: ReadonlySet<SidebarNavId> = new Set(['essay', 'bits', 'memo', 'archive', 'about']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_HOSTS = ['github.com'];
const X_HOSTS = ['x.com', 'twitter.com'];

const SIDEBAR_HREFS: Record<SidebarNavId, string> = {
  essay: '/essay/',
  bits: '/bits/',
  memo: '/memo/',
  archive: '/archive/',
  about: '/about/'
};

let cachedSettings: ThemeSettingsResolved | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

const asNonEmptyString = (value: unknown): string | undefined => {
  const next = asString(value);
  return next ? next : undefined;
};

const asNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;

  const next = asString(value);
  if (next === undefined) return undefined;
  return next || null;
};

const asHttpsUrl = (value: unknown, allowedHosts?: readonly string[]): string | null | undefined => {
  if (value === null) return null;

  const next = asString(value);
  if (next === undefined) return undefined;
  if (!next) return null;

  try {
    const parsed = new URL(next);
    if (parsed.protocol !== 'https:') return undefined;
    if (allowedHosts?.length) {
      const hostname = parsed.hostname.toLowerCase();
      const isAllowed = allowedHosts.some(
        (host) => hostname === host || hostname === `www.${host}` || hostname.endsWith(`.${host}`)
      );
      if (!isAllowed) return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
};

const asEmailAddress = (value: unknown): string | null | undefined => {
  if (value === null) return null;

  const next = asString(value);
  if (next === undefined) return undefined;
  if (!next) return null;

  const normalized = next.replace(/^mailto:/i, '').trim();
  return EMAIL_RE.test(normalized) ? normalized : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asNavId = (value: unknown): SidebarNavId | undefined => {
  if (typeof value !== 'string') return undefined;
  return NAV_IDS.has(value as SidebarNavId) ? (value as SidebarNavId) : undefined;
};

const asHeroPresetId = (value: unknown): HeroPresetId | undefined => {
  if (typeof value !== 'string') return undefined;
  return HERO_PRESETS.has(value as HeroPresetId) ? (value as HeroPresetId) : undefined;
};

const resolveValue = <T>(
  nextValue: T | undefined,
  legacyValue: T | undefined,
  defaultValue: T
): { value: T; source: SettingSource } => {
  if (nextValue !== undefined) return { value: nextValue, source: 'new' };
  if (legacyValue !== undefined) return { value: legacyValue, source: 'legacy' };
  return { value: defaultValue, source: 'default' };
};

const readSettingsObject = (name: 'site' | 'shell' | 'home' | 'page' | 'ui'): Record<string, unknown> | undefined => {
  const filePath = join(SETTINGS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch (error) {
    console.warn(`[astro-whono] Failed to read ${filePath}:`, error);
    return undefined;
  }
};

const parseSidebarNav = (value: unknown): SidebarNavItem[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const merged = new Map<SidebarNavId, SidebarNavItem>(
    LEGACY_NAV.map((item) => [item.id, { ...item }])
  );
  let hasOverride = false;

  for (const row of value) {
    if (!isRecord(row)) continue;
    const id = asNavId(row.id);
    if (!id) continue;
    const current = merged.get(id);
    if (!current) continue;

    const label = asNonEmptyString(row.label) ?? current.label;
    const visible = asBoolean(row.visible) ?? current.visible;
    const order = asFiniteNumber(row.order) ?? current.order;

    merged.set(id, { id, label, visible, order });
    hasOverride = true;
  }

  if (!hasOverride) return undefined;
  return Array.from(merged.values()).sort((a, b) => a.order - b.order);
};

export const getThemeSettings = (): ThemeSettingsResolved => {
  if (cachedSettings) return cachedSettings;

  const siteJson = readSettingsObject('site');
  const shellJson = readSettingsObject('shell');
  const homeJson = readSettingsObject('home');
  const pageJson = readSettingsObject('page');
  const uiJson = readSettingsObject('ui');

  const siteFooterJson = isRecord(siteJson?.footer) ? siteJson.footer : undefined;
  const siteSocialLinksJson = isRecord(siteJson?.socialLinks) ? siteJson.socialLinks : undefined;
  const pageEssayJson = isRecord(pageJson?.essay) ? pageJson.essay : undefined;
  const pageArchiveJson = isRecord(pageJson?.archive) ? pageJson.archive : undefined;
  const pageBitsJson = isRecord(pageJson?.bits) ? pageJson.bits : undefined;
  const pageBitsDefaultAuthorJson = isRecord(pageBitsJson?.defaultAuthor) ? pageBitsJson.defaultAuthor : undefined;
  const pageMemoJson = isRecord(pageJson?.memo) ? pageJson.memo : undefined;
  const pageAboutJson = isRecord(pageJson?.about) ? pageJson.about : undefined;

  const title = resolveValue(
    asNonEmptyString(siteJson?.title),
    asNonEmptyString(legacySite.title),
    DEFAULT_SITE.title
  );
  const description = resolveValue(
    asNonEmptyString(siteJson?.description),
    asNonEmptyString(legacySite.description),
    DEFAULT_SITE.description
  );
  const defaultLocale = resolveValue(
    asNonEmptyString(siteJson?.defaultLocale),
    undefined,
    DEFAULT_SITE.defaultLocale
  );
  const footerCopyright = resolveValue(
    asNonEmptyString(siteFooterJson?.copyright),
    LEGACY_FOOTER_COPYRIGHT,
    DEFAULT_SITE.footer.copyright
  );
  const socialLinksGithub = resolveValue(
    asHttpsUrl(siteSocialLinksJson?.github, GITHUB_HOSTS),
    LEGACY_SOCIAL_LINKS.github,
    DEFAULT_SITE.socialLinks.github
  );
  const socialLinksX = resolveValue(
    asHttpsUrl(siteSocialLinksJson?.x, X_HOSTS),
    LEGACY_SOCIAL_LINKS.x,
    DEFAULT_SITE.socialLinks.x
  );
  const socialLinksEmail = resolveValue(
    asEmailAddress(siteSocialLinksJson?.email),
    LEGACY_SOCIAL_LINKS.email,
    DEFAULT_SITE.socialLinks.email
  );
  const socialLinksRss = resolveValue(
    asBoolean(siteSocialLinksJson?.rss),
    LEGACY_SOCIAL_LINKS.rss,
    DEFAULT_SITE.socialLinks.rss
  );

  const brandTitle = resolveValue(
    asNonEmptyString(shellJson?.brandTitle),
    asNonEmptyString(legacySite.brandTitle),
    DEFAULT_SHELL.brandTitle
  );
  const quote = resolveValue(
    asNonEmptyString(shellJson?.quote),
    LEGACY_QUOTE,
    DEFAULT_SHELL.quote
  );
  const nav = resolveValue(
    parseSidebarNav(shellJson?.nav),
    cloneNavItems(LEGACY_NAV),
    cloneNavItems(DEFAULT_SHELL.nav)
  );

  const introLead = resolveValue(
    asNonEmptyString(homeJson?.introLead),
    LEGACY_INTRO_LEAD,
    DEFAULT_HOME.introLead
  );
  const introMore = resolveValue(
    asNonEmptyString(homeJson?.introMore),
    LEGACY_INTRO_MORE,
    DEFAULT_HOME.introMore
  );
  const heroPresetId = resolveValue(
    asHeroPresetId(homeJson?.heroPresetId),
    DEFAULT_HOME.heroPresetId,
    DEFAULT_HOME.heroPresetId
  );

  const essaySubtitle = resolveValue(
    asNullableString(pageEssayJson?.subtitle),
    LEGACY_ESSAY_SUBTITLE,
    DEFAULT_PAGE.essay.subtitle
  );
  const archiveSubtitle = resolveValue(
    asNullableString(pageArchiveJson?.subtitle),
    undefined,
    DEFAULT_PAGE.archive.subtitle
  );
  const bitsSubtitle = resolveValue(
    asNullableString(pageBitsJson?.subtitle),
    LEGACY_BITS_SUBTITLE,
    DEFAULT_PAGE.bits.subtitle
  );
  const bitsDefaultAuthorName = resolveValue(
    asNonEmptyString(pageBitsDefaultAuthorJson?.name),
    asNonEmptyString(legacySite.author),
    DEFAULT_PAGE.bits.defaultAuthor.name
  );
  const bitsDefaultAuthorAvatar = resolveValue(
    asString(pageBitsDefaultAuthorJson?.avatar),
    asString(legacySite.authorAvatar),
    DEFAULT_PAGE.bits.defaultAuthor.avatar
  );
  const memoSubtitle = resolveValue<string | null>(
    asNullableString(pageMemoJson?.subtitle),
    undefined,
    DEFAULT_PAGE.memo.subtitle
  );
  const aboutSubtitle = resolveValue<string | null>(
    asNullableString(pageAboutJson?.subtitle),
    undefined,
    DEFAULT_PAGE.about.subtitle
  );

  const uiCodeBlock = isRecord(uiJson?.codeBlock) ? uiJson.codeBlock : undefined;
  const uiReadingMode = isRecord(uiJson?.readingMode) ? uiJson.readingMode : undefined;

  const showLineNumbers = resolveValue(
    asBoolean(uiCodeBlock?.showLineNumbers),
    true,
    true
  );
  const showReadingEntry = resolveValue(
    asBoolean(uiReadingMode?.showEntry),
    true,
    true
  );

  const resolved: ThemeSettingsResolved = {
    settings: {
      site: {
        title: title.value,
        description: description.value,
        defaultLocale: defaultLocale.value,
        footer: {
          copyright: footerCopyright.value
        },
        socialLinks: {
          github: socialLinksGithub.value,
          x: socialLinksX.value,
          email: socialLinksEmail.value,
          rss: socialLinksRss.value
        }
      },
      shell: {
        brandTitle: brandTitle.value,
        quote: quote.value,
        nav: cloneNavItems(nav.value)
      },
      home: {
        introLead: introLead.value,
        introMore: introMore.value,
        heroPresetId: heroPresetId.value
      },
      page: {
        essay: {
          subtitle: essaySubtitle.value
        },
        archive: {
          subtitle: archiveSubtitle.value
        },
        bits: {
          subtitle: bitsSubtitle.value,
          defaultAuthor: {
            name: bitsDefaultAuthorName.value,
            avatar: bitsDefaultAuthorAvatar.value
          }
        },
        memo: {
          subtitle: memoSubtitle.value
        },
        about: {
          subtitle: aboutSubtitle.value
        }
      },
      ui: {
        codeBlock: {
          showLineNumbers: showLineNumbers.value
        },
        readingMode: {
          showEntry: showReadingEntry.value
        }
      }
    },
    sources: {
      site: {
        title: title.source,
        description: description.source,
        defaultLocale: defaultLocale.source,
        footerCopyright: footerCopyright.source,
        socialLinksGithub: socialLinksGithub.source,
        socialLinksX: socialLinksX.source,
        socialLinksEmail: socialLinksEmail.source,
        socialLinksRss: socialLinksRss.source
      },
      shell: {
        brandTitle: brandTitle.source,
        quote: quote.source,
        nav: nav.source
      },
      home: {
        introLead: introLead.source,
        introMore: introMore.source,
        heroPresetId: heroPresetId.source
      },
      page: {
        essaySubtitle: essaySubtitle.source,
        archiveSubtitle: archiveSubtitle.source,
        bitsSubtitle: bitsSubtitle.source,
        bitsDefaultAuthorName: bitsDefaultAuthorName.source,
        bitsDefaultAuthorAvatar: bitsDefaultAuthorAvatar.source,
        memoSubtitle: memoSubtitle.source,
        aboutSubtitle: aboutSubtitle.source
      },
      ui: {
        codeBlockShowLineNumbers: showLineNumbers.source,
        readingModeShowEntry: showReadingEntry.source
      }
    }
  };

  cachedSettings = resolved;
  return resolved;
};

export const resetThemeSettingsCache = (): void => {
  cachedSettings = null;
};

export const getSidebarHref = (id: SidebarNavId): string => SIDEBAR_HREFS[id];
