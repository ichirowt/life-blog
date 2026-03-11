import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import {
  getThemeSettings,
  resetThemeSettingsCache,
  type HeroPresetId,
  type PageId,
  type SidebarNavId,
  type ThemeSettings
} from '../../../lib/theme-settings';

// DEV 需要动态 POST；PROD 构建保持静态输出，避免静态站额外依赖 adapter。
export const prerender = import.meta.env.PROD;

type WritableGroup = 'site' | 'shell' | 'home' | 'page' | 'ui';

type NavInputItem = {
  id: SidebarNavId;
  label: string;
  visible: boolean;
  order: number;
};

const SETTINGS_DIR = join(process.cwd(), 'src', 'data', 'settings');
const SETTINGS_FILES: Record<WritableGroup, string> = {
  site: join(SETTINGS_DIR, 'site.json'),
  shell: join(SETTINGS_DIR, 'shell.json'),
  home: join(SETTINGS_DIR, 'home.json'),
  page: join(SETTINGS_DIR, 'page.json'),
  ui: join(SETTINGS_DIR, 'ui.json')
};

const NAV_IDS: ReadonlyArray<SidebarNavId> = ['essay', 'bits', 'memo', 'archive', 'about'];
const PAGE_IDS: ReadonlyArray<PageId> = ['essay', 'archive', 'bits', 'memo', 'about'];
const HERO_PRESETS: ReadonlySet<HeroPresetId> = new Set(['default', 'minimal', 'none']);
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GITHUB_HOSTS = ['github.com'];
const X_HOSTS = ['x.com', 'twitter.com'];
const HOME_INTRO_MAX_LENGTH = 240;
const PAGE_SUBTITLE_MAX_LENGTH = 120;

const SITE_KEYS = ['title', 'description', 'defaultLocale', 'footer', 'socialLinks'] as const;
const SHELL_KEYS = ['brandTitle', 'quote', 'nav'] as const;
const HOME_KEYS = ['introLead', 'introMore', 'heroPresetId'] as const;
const PAGE_KEYS = ['essay', 'archive', 'bits', 'memo', 'about'] as const;
const UI_KEYS = ['codeBlock', 'readingMode'] as const;
const FOOTER_KEYS = ['copyright'] as const;
const SOCIAL_LINK_KEYS = ['github', 'x', 'email', 'rss'] as const;
const CODE_BLOCK_KEYS = ['showLineNumbers'] as const;
const READING_MODE_KEYS = ['showEntry'] as const;
const NAV_ITEM_KEYS = ['id', 'label', 'visible', 'order'] as const;
const PAGE_ITEM_KEYS = ['subtitle'] as const;
const BITS_PAGE_KEYS = ['subtitle', 'defaultAuthor'] as const;
const DEFAULT_AUTHOR_KEYS = ['name', 'avatar'] as const;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toTrimmedString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

const toNullableTrimmedString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const toInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number.isInteger(value) ? value : undefined;
};

const collectUnknownKeys = (
  scope: string,
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
  errors: string[]
): void => {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      errors.push(`${scope} 出现未知字段：${key}`);
    }
  }
};

const toHttpsUrl = (value: unknown, allowedHosts: readonly string[]): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return undefined;

    const hostname = parsed.hostname.toLowerCase();
    const isAllowed = allowedHosts.some(
      (host) => hostname === host || hostname === `www.${host}` || hostname.endsWith(`.${host}`)
    );
    if (!isAllowed) return undefined;

    return parsed.toString();
  } catch {
    return undefined;
  }
};

const toEmailAddress = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/^mailto:/i, '').trim();
  return EMAIL_RE.test(normalized) ? normalized : undefined;
};

const validateRelativeAvatarPath = (scope: string, value: string, errors: string[]): void => {
  if (!value) return;
  if (value.startsWith('/')) {
    errors.push(`${scope} 必须是相对路径，不能以 / 开头`);
  }
  if (/^[A-Za-z]+:\/\//.test(value)) {
    errors.push(`${scope} 当前仅允许相对路径，不允许 URL`);
  }
};

const parseNavItem = (value: unknown, errors: string[], index: number): NavInputItem | null => {
  if (!isRecord(value)) {
    errors.push(`shell.nav[${index}] 必须是对象`);
    return null;
  }

  collectUnknownKeys(`shell.nav[${index}]`, value, NAV_ITEM_KEYS, errors);

  const idRaw = toTrimmedString(value.id);
  if (!idRaw || !NAV_IDS.includes(idRaw as SidebarNavId)) {
    errors.push(`shell.nav[${index}].id 非法`);
    return null;
  }
  const id = idRaw as SidebarNavId;

  const label = toTrimmedString(value.label);
  if (!label) errors.push(`shell.nav[${index}].label 不能为空`);

  const visible = toBoolean(value.visible);
  if (visible === undefined) errors.push(`shell.nav[${index}].visible 必须是布尔值`);

  const order = toInteger(value.order);
  if (order === undefined || order < 1 || order > 999) {
    errors.push(`shell.nav[${index}].order 必须是 1-999 的整数`);
  }

  if (!label || visible === undefined || order === undefined || order < 1 || order > 999) {
    return null;
  }

  return { id, label, visible, order };
};

const applySubtitle = (
  scope: string,
  input: Record<string, unknown>,
  target: { subtitle: string | null },
  errors: string[]
): void => {
  if (!Object.prototype.hasOwnProperty.call(input, 'subtitle')) {
    return;
  }

  const subtitle = toNullableTrimmedString(input.subtitle);
  if (subtitle === undefined) {
    errors.push(`${scope}.subtitle 必须是字符串、null 或留空`);
    return;
  }
  if (typeof subtitle === 'string') {
    if (subtitle.includes('\n') || subtitle.includes('\r')) {
      errors.push(`${scope}.subtitle 只允许单行文本`);
      return;
    }
    if (subtitle.length > PAGE_SUBTITLE_MAX_LENGTH) {
      errors.push(`${scope}.subtitle 不能超过 ${PAGE_SUBTITLE_MAX_LENGTH} 个字符`);
      return;
    }
  }

  target.subtitle = subtitle;
};

const createResults = (writtenGroups: WritableGroup[]) => ({
  site: { received: writtenGroups.includes('site'), written: false },
  shell: { received: writtenGroups.includes('shell'), written: false },
  home: { received: writtenGroups.includes('home'), written: false },
  page: { received: writtenGroups.includes('page'), written: false },
  ui: { received: writtenGroups.includes('ui'), written: false }
});

const parsePatch = (
  input: unknown,
  current: ThemeSettings
): { patch: Partial<ThemeSettings>; writtenGroups: WritableGroup[]; errors: string[] } => {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { patch: {}, writtenGroups: [], errors: ['请求体必须是 JSON 对象'] };
  }

  collectUnknownKeys('root', input, ['site', 'shell', 'home', 'page', 'ui'], errors);

  const patch: Partial<ThemeSettings> = {};
  const writtenGroups: WritableGroup[] = [];

  if (Object.prototype.hasOwnProperty.call(input, 'site')) {
    const rawSite = input.site;
    if (!isRecord(rawSite)) {
      errors.push('site 必须是对象');
    } else {
      collectUnknownKeys('site', rawSite, SITE_KEYS, errors);
      const nextSite = {
        ...current.site,
        footer: { ...current.site.footer },
        socialLinks: { ...current.site.socialLinks }
      };

      if (Object.prototype.hasOwnProperty.call(rawSite, 'title')) {
        const value = toTrimmedString(rawSite.title);
        if (!value) errors.push('site.title 不能为空');
        else nextSite.title = value;
      }
      if (Object.prototype.hasOwnProperty.call(rawSite, 'description')) {
        const value = toTrimmedString(rawSite.description);
        if (!value) errors.push('site.description 不能为空');
        else nextSite.description = value;
      }
      if (Object.prototype.hasOwnProperty.call(rawSite, 'defaultLocale')) {
        const value = toTrimmedString(rawSite.defaultLocale);
        if (!value) {
          errors.push('site.defaultLocale 不能为空');
        } else if (!LOCALE_RE.test(value)) {
          errors.push('site.defaultLocale 格式非法（示例：zh-CN）');
        } else {
          nextSite.defaultLocale = value;
        }
      }
      if (Object.prototype.hasOwnProperty.call(rawSite, 'footer')) {
        const rawFooter = rawSite.footer;
        if (!isRecord(rawFooter)) {
          errors.push('site.footer 必须是对象');
        } else {
          collectUnknownKeys('site.footer', rawFooter, FOOTER_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawFooter, 'copyright')) {
            const value = toTrimmedString(rawFooter.copyright);
            if (!value) {
              errors.push('site.footer.copyright 不能为空');
            } else if (value.includes('\n') || value.includes('\r')) {
              errors.push('site.footer.copyright 只允许单行文本');
            } else if (value.length > 120) {
              errors.push('site.footer.copyright 不能超过 120 个字符');
            } else {
              nextSite.footer.copyright = value;
            }
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(rawSite, 'socialLinks')) {
        const rawSocialLinks = rawSite.socialLinks;
        if (!isRecord(rawSocialLinks)) {
          errors.push('site.socialLinks 必须是对象');
        } else {
          collectUnknownKeys('site.socialLinks', rawSocialLinks, SOCIAL_LINK_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'github')) {
            const value = toHttpsUrl(rawSocialLinks.github, GITHUB_HOSTS);
            if (value === undefined) {
              errors.push('site.socialLinks.github 只允许 https://github.com/... 或留空');
            } else {
              nextSite.socialLinks.github = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'x')) {
            const value = toHttpsUrl(rawSocialLinks.x, X_HOSTS);
            if (value === undefined) {
              errors.push('site.socialLinks.x 只允许 https://x.com/...、https://twitter.com/... 或留空');
            } else {
              nextSite.socialLinks.x = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'email')) {
            const value = toEmailAddress(rawSocialLinks.email);
            if (value === undefined) {
              errors.push('site.socialLinks.email 必须是邮箱地址、mailto: 语义或留空');
            } else {
              nextSite.socialLinks.email = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'rss')) {
            const value = toBoolean(rawSocialLinks.rss);
            if (value === undefined) {
              errors.push('site.socialLinks.rss 必须是布尔值');
            } else {
              nextSite.socialLinks.rss = value;
            }
          }
        }
      }

      patch.site = nextSite;
      writtenGroups.push('site');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'shell')) {
    const rawShell = input.shell;
    if (!isRecord(rawShell)) {
      errors.push('shell 必须是对象');
    } else {
      collectUnknownKeys('shell', rawShell, SHELL_KEYS, errors);
      const nextShell = {
        ...current.shell,
        nav: current.shell.nav.map((item) => ({ ...item }))
      };

      if (Object.prototype.hasOwnProperty.call(rawShell, 'brandTitle')) {
        const value = toTrimmedString(rawShell.brandTitle);
        if (!value) errors.push('shell.brandTitle 不能为空');
        else nextShell.brandTitle = value;
      }
      if (Object.prototype.hasOwnProperty.call(rawShell, 'quote')) {
        const value = toTrimmedString(rawShell.quote);
        if (!value) errors.push('shell.quote 不能为空');
        else nextShell.quote = value;
      }
      if (Object.prototype.hasOwnProperty.call(rawShell, 'nav')) {
        const rawNav = rawShell.nav;
        if (!Array.isArray(rawNav)) {
          errors.push('shell.nav 必须是数组');
        } else {
          const parsedNav = rawNav
            .map((item, index) => parseNavItem(item, errors, index))
            .filter((item): item is NavInputItem => item !== null);

          if (parsedNav.length === NAV_IDS.length) {
            const seenIds = new Set<SidebarNavId>();
            const seenOrder = new Set<number>();
            for (const row of parsedNav) {
              if (seenIds.has(row.id)) errors.push(`shell.nav ID 重复：${row.id}`);
              if (seenOrder.has(row.order)) errors.push(`shell.nav 排序重复：${row.order}`);
              seenIds.add(row.id);
              seenOrder.add(row.order);
            }
            for (const navId of NAV_IDS) {
              if (!seenIds.has(navId)) {
                errors.push(`shell.nav 缺少导航项：${navId}`);
              }
            }

            nextShell.nav = parsedNav.sort((a, b) => {
              if (a.order !== b.order) return a.order - b.order;
              return NAV_IDS.indexOf(a.id) - NAV_IDS.indexOf(b.id);
            });
          } else if (rawNav.length !== NAV_IDS.length) {
            errors.push(`shell.nav 必须包含 ${NAV_IDS.length} 个既有导航项`);
          }
        }
      }

      patch.shell = nextShell;
      writtenGroups.push('shell');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'home')) {
    const rawHome = input.home;
    if (!isRecord(rawHome)) {
      errors.push('home 必须是对象');
    } else {
      collectUnknownKeys('home', rawHome, HOME_KEYS, errors);
      const nextHome = { ...current.home };

      if (Object.prototype.hasOwnProperty.call(rawHome, 'introLead')) {
        const value = toTrimmedString(rawHome.introLead);
        if (!value) {
          errors.push('home.introLead 不能为空');
        } else if (value.length > HOME_INTRO_MAX_LENGTH) {
          errors.push(`home.introLead 不能超过 ${HOME_INTRO_MAX_LENGTH} 个字符`);
        } else {
          nextHome.introLead = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'introMore')) {
        const value = toTrimmedString(rawHome.introMore);
        if (!value) {
          errors.push('home.introMore 不能为空');
        } else if (value.length > HOME_INTRO_MAX_LENGTH) {
          errors.push(`home.introMore 不能超过 ${HOME_INTRO_MAX_LENGTH} 个字符`);
        } else {
          nextHome.introMore = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'heroPresetId')) {
        const value = toTrimmedString(rawHome.heroPresetId);
        if (!value || !HERO_PRESETS.has(value as HeroPresetId)) {
          errors.push('home.heroPresetId 只允许 default/minimal/none');
        } else {
          nextHome.heroPresetId = value as HeroPresetId;
        }
      }

      patch.home = nextHome;
      writtenGroups.push('home');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'page')) {
    const rawPage = input.page;
    if (!isRecord(rawPage)) {
      errors.push('page 必须是对象');
    } else {
      collectUnknownKeys('page', rawPage, PAGE_KEYS, errors);
      const nextPage = {
        essay: { ...current.page.essay },
        archive: { ...current.page.archive },
        bits: {
          ...current.page.bits,
          defaultAuthor: { ...current.page.bits.defaultAuthor }
        },
        memo: { ...current.page.memo },
        about: { ...current.page.about }
      };

      for (const pageId of PAGE_IDS) {
        if (!Object.prototype.hasOwnProperty.call(rawPage, pageId)) continue;
        const rawItem = rawPage[pageId];
        if (!isRecord(rawItem)) {
          errors.push(`page.${pageId} 必须是对象`);
          continue;
        }

        if (pageId === 'bits') {
          collectUnknownKeys(`page.${pageId}`, rawItem, BITS_PAGE_KEYS, errors);
          applySubtitle(`page.${pageId}`, rawItem, nextPage.bits, errors);

          if (Object.prototype.hasOwnProperty.call(rawItem, 'defaultAuthor')) {
            const rawDefaultAuthor = rawItem.defaultAuthor;
            if (!isRecord(rawDefaultAuthor)) {
              errors.push('page.bits.defaultAuthor 必须是对象');
            } else {
              collectUnknownKeys('page.bits.defaultAuthor', rawDefaultAuthor, DEFAULT_AUTHOR_KEYS, errors);

              if (Object.prototype.hasOwnProperty.call(rawDefaultAuthor, 'name')) {
                const value = toTrimmedString(rawDefaultAuthor.name);
                if (!value) errors.push('page.bits.defaultAuthor.name 不能为空');
                else nextPage.bits.defaultAuthor.name = value;
              }

              if (Object.prototype.hasOwnProperty.call(rawDefaultAuthor, 'avatar')) {
                const value = toTrimmedString(rawDefaultAuthor.avatar);
                if (value === undefined) {
                  errors.push('page.bits.defaultAuthor.avatar 必须是字符串');
                } else {
                  validateRelativeAvatarPath('page.bits.defaultAuthor.avatar', value, errors);
                  nextPage.bits.defaultAuthor.avatar = value;
                }
              }
            }
          }

          continue;
        }

        collectUnknownKeys(`page.${pageId}`, rawItem, PAGE_ITEM_KEYS, errors);
        applySubtitle(`page.${pageId}`, rawItem, nextPage[pageId], errors);
      }

      patch.page = nextPage;
      writtenGroups.push('page');
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'ui')) {
    const rawUi = input.ui;
    if (!isRecord(rawUi)) {
      errors.push('ui 必须是对象');
    } else {
      collectUnknownKeys('ui', rawUi, UI_KEYS, errors);
      const nextUi = {
        codeBlock: { ...current.ui.codeBlock },
        readingMode: { ...current.ui.readingMode }
      };

      if (Object.prototype.hasOwnProperty.call(rawUi, 'codeBlock')) {
        const rawCodeBlock = rawUi.codeBlock;
        if (!isRecord(rawCodeBlock)) {
          errors.push('ui.codeBlock 必须是对象');
        } else {
          collectUnknownKeys('ui.codeBlock', rawCodeBlock, CODE_BLOCK_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawCodeBlock, 'showLineNumbers')) {
            const value = toBoolean(rawCodeBlock.showLineNumbers);
            if (value === undefined) errors.push('ui.codeBlock.showLineNumbers 必须是布尔值');
            else nextUi.codeBlock.showLineNumbers = value;
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawUi, 'readingMode')) {
        const rawReadingMode = rawUi.readingMode;
        if (!isRecord(rawReadingMode)) {
          errors.push('ui.readingMode 必须是对象');
        } else {
          collectUnknownKeys('ui.readingMode', rawReadingMode, READING_MODE_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawReadingMode, 'showEntry')) {
            const value = toBoolean(rawReadingMode.showEntry);
            if (value === undefined) errors.push('ui.readingMode.showEntry 必须是布尔值');
            else nextUi.readingMode.showEntry = value;
          }
        }
      }

      patch.ui = nextUi;
      writtenGroups.push('ui');
    }
  }

  if (!writtenGroups.length) {
    errors.push('请求体至少需要包含 site/shell/home/page/ui 中的一组');
  }

  return { patch, writtenGroups, errors };
};

const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

  try {
    await writeFile(tempPath, serialized, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

export const GET: APIRoute = async () => {
  const payload = getThemeSettings();
  return new Response(JSON.stringify(payload, null, 2), { headers: JSON_HEADERS });
};

export const POST: APIRoute = async ({ request }) => {
  if (!import.meta.env.DEV) {
    return new Response('Not Found', { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    const rawBody = await request.clone().text();
    const trimmedBody = rawBody.trim();
    if (!trimmedBody) {
      return new Response(
        JSON.stringify(
          {
            ok: false,
            errors: ['请求体为空，请确认前端请求地址未发生重定向且已发送 JSON 字符串']
          },
          null,
          2
        ),
        { status: 400, headers: JSON_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({ ok: false, errors: ['请求体不是合法 JSON'] }, null, 2),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const current = getThemeSettings().settings;
  const { patch, writtenGroups, errors } = parsePatch(body, current);

  if (errors.length) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          errors,
          results: createResults(writtenGroups)
        },
        null,
        2
      ),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const results = createResults(writtenGroups);

  try {
    if (patch.site && results.site.received) {
      await writeJsonAtomic(SETTINGS_FILES.site, patch.site);
      results.site.written = true;
    }
    if (patch.shell && results.shell.received) {
      await writeJsonAtomic(SETTINGS_FILES.shell, patch.shell);
      results.shell.written = true;
    }
    if (patch.home && results.home.received) {
      await writeJsonAtomic(SETTINGS_FILES.home, patch.home);
      results.home.written = true;
    }
    if (patch.page && results.page.received) {
      await writeJsonAtomic(SETTINGS_FILES.page, patch.page);
      results.page.written = true;
    }
    if (patch.ui && results.ui.received) {
      await writeJsonAtomic(SETTINGS_FILES.ui, patch.ui);
      results.ui.written = true;
    }

    resetThemeSettingsCache();
    const payload = getThemeSettings();

    return new Response(
      JSON.stringify(
        {
          ok: true,
          results,
          payload
        },
        null,
        2
      ),
      { headers: JSON_HEADERS }
    );
  } catch (error) {
    console.error('[astro-whono] Failed to persist admin settings:', error);
    return new Response(
      JSON.stringify(
        {
          ok: false,
          errors: ['写入配置文件失败，请检查本地文件权限或日志'],
          results
        },
        null,
        2
      ),
      { status: 500, headers: JSON_HEADERS }
    );
  }
};
