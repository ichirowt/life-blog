import { existsSync } from 'node:fs';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { APIRoute } from 'astro';
import {
  getEditableThemeSettingsState,
  getThemeSettings,
  resetThemeSettingsCache,
  type HeroPresetId,
  type HomeIntroLinkKey,
  type SidebarNavId,
  type SiteSocialCustomItem,
  type ThemeSettings
} from '../../../lib/theme-settings';
import {
  ADMIN_ARTICLE_META_DATE_LABEL_MAX_LENGTH,
  ADMIN_SOCIAL_ORDER_MAX,
  ADMIN_SOCIAL_ORDER_MIN,
  ADMIN_EMAIL_RE,
  ADMIN_FOOTER_COPYRIGHT_MAX_LENGTH,
  ADMIN_FOOTER_START_YEAR_MIN,
  ADMIN_GITHUB_HOSTS,
  ADMIN_HERO_IMAGE_ALT_DEFAULT,
  ADMIN_HERO_IMAGE_ALT_MAX_LENGTH,
  ADMIN_HERO_PRESET_SET,
  ADMIN_HOME_INTRO_LINK_KEYS,
  ADMIN_HOME_INTRO_LINK_LIMIT,
  ADMIN_HOME_INTRO_MAX_LENGTH,
  ADMIN_LOCALE_RE,
  ADMIN_NAV_IDS,
  ADMIN_NAV_ORDER_MAX,
  ADMIN_NAV_ORDER_MIN,
  ADMIN_NAV_ORNAMENT_DEFAULT,
  ADMIN_NAV_ORNAMENT_MAX_LENGTH,
  ADMIN_PAGE_IDS,
  ADMIN_PAGE_TITLE_MAX_LENGTH,
  ADMIN_PAGE_SUBTITLE_MAX_LENGTH,
  ADMIN_SIDEBAR_DIVIDER_DEFAULT,
  ADMIN_SOCIAL_CUSTOM_LIMIT,
  ADMIN_SOCIAL_PRESET_IDS,
  ADMIN_X_HOSTS,
  getAdminBitsAvatarLocalFilePath,
  getAdminNavOrderIssues,
  getAdminSocialOrderIssues,
  getAdminHeroImageLocalFilePath,
  getAdminFooterStartYearMax,
  isAdminHomeIntroLinkKey,
  isAdminSidebarDividerVariant,
  isAdminNavId,
  normalizeAdminBitsAvatarPath,
  normalizeAdminHeroImageSrc,
  normalizeAdminSocialIconKey
} from '../../../lib/admin-console/shared';

type WritableGroup = 'site' | 'shell' | 'home' | 'page' | 'ui';

type NavInputItem = {
  id: SidebarNavId;
  label: string;
  ornament: string | null;
  visible: boolean;
  order: number;
};

type PersistEntry = {
  group: WritableGroup;
  filePath: string;
  data: unknown;
};

type PersistOperation = PersistEntry & {
  tempPath: string;
  backupPath: string;
  existed: boolean;
  committed: boolean;
  backupCreated: boolean;
};

type WriteRequestValidation = {
  status: number;
  error: string;
};

const SETTINGS_DIR = join(process.cwd(), 'src', 'data', 'settings');
const SETTINGS_FILES: Record<WritableGroup, string> = {
  site: join(SETTINGS_DIR, 'site.json'),
  shell: join(SETTINGS_DIR, 'shell.json'),
  home: join(SETTINGS_DIR, 'home.json'),
  page: join(SETTINGS_DIR, 'page.json'),
  ui: join(SETTINGS_DIR, 'ui.json')
};

const FOOTER_START_YEAR_MAX = getAdminFooterStartYearMax();

const SITE_KEYS = ['title', 'description', 'defaultLocale', 'footer', 'socialLinks'] as const;
const SHELL_KEYS = ['brandTitle', 'quote', 'nav'] as const;
const HOME_KEYS = [
  'introLead',
  'introMore',
  'introMoreLinks',
  'showIntroLead',
  'showIntroMore',
  'heroPresetId',
  'heroImageSrc',
  'heroImageAlt'
] as const;
const PAGE_KEYS = ['essay', 'archive', 'bits', 'memo', 'about'] as const;
const UI_KEYS = ['codeBlock', 'readingMode', 'articleMeta', 'layout'] as const;
const FOOTER_KEYS = ['startYear', 'showCurrentYear', 'copyright'] as const;
const SOCIAL_LINK_KEYS = ['github', 'x', 'email', 'presetOrder', 'custom'] as const;
const SOCIAL_CUSTOM_ITEM_KEYS = ['id', 'label', 'href', 'iconKey', 'visible', 'order'] as const;
const CODE_BLOCK_KEYS = ['showLineNumbers'] as const;
const READING_MODE_KEYS = ['showEntry'] as const;
const ARTICLE_META_KEYS = [
  'showDate',
  'dateLabel',
  'showTags',
  'showWordCount',
  'showReadingTime'
] as const;
const LAYOUT_KEYS = ['sidebarDivider'] as const;
const NAV_ITEM_KEYS = ['id', 'label', 'ornament', 'visible', 'order'] as const;
const PAGE_HEADING_KEYS = ['title', 'subtitle'] as const;
const MEMO_PAGE_KEYS = ['title', 'subtitle'] as const;
const BITS_PAGE_KEYS = ['title', 'subtitle', 'defaultAuthor'] as const;
const DEFAULT_AUTHOR_KEYS = ['name', 'avatar'] as const;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store'
};

const DEV_ONLY_NOT_FOUND_RESPONSE = new Response('Not Found', { status: 404 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toTrimmedString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.trim() : undefined;

const toSingleLineTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.includes('\n') || trimmed.includes('\r') ? undefined : trimmed;
};

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

const createJsonBody = (data: unknown): string => `${JSON.stringify(data, null, 2)}\n`;

const createTransientFilePath = (filePath: string, suffix: 'tmp' | 'bak'): string =>
  `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.${suffix}`;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const parseHeaderOrigin = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const validateAdminWriteRequest = (request: Request, currentUrl: URL): WriteRequestValidation | null => {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    return {
      status: 415,
      error: '仅允许 application/json 请求写入 Theme Console 配置'
    };
  }

  const currentOrigin = currentUrl.origin;
  const origin = parseHeaderOrigin(request.headers.get('origin'));
  const refererOrigin = parseHeaderOrigin(request.headers.get('referer'));
  const requestOrigin = origin ?? refererOrigin;

  if (!requestOrigin) {
    return {
      status: 403,
      error: '写入请求缺少来源标识，仅允许从当前开发站点同源提交'
    };
  }

  if (requestOrigin !== currentOrigin) {
    return {
      status: 403,
      error: '仅允许从当前开发站点同源写入 Theme Console 配置'
    };
  }

  return null;
};

const isDryRunWriteRequest = (url: URL): boolean => {
  const rawValue = url.searchParams.get('dryRun')?.trim().toLowerCase();
  return rawValue === '1' || rawValue === 'true';
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

const toHttpsUrl = (value: unknown, allowedHosts?: readonly string[]): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
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

const toEmailAddress = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/^mailto:/i, '').trim();
  return ADMIN_EMAIL_RE.test(normalized) ? normalized : undefined;
};

const validateBitsAvatarPath = (scope: string, value: string, errors: string[]): string => {
  const normalized = normalizeAdminBitsAvatarPath(value);
  if (normalized === undefined) {
    errors.push(`${scope} 只允许相对图片路径（例如 author/avatar.webp），不要带 public/、不要以 / 开头，也不要包含 URL、..、?、#`);
    return value;
  }

  const localFilePath = getAdminBitsAvatarLocalFilePath(normalized);
  if (localFilePath && !hasProjectFile(localFilePath)) {
    errors.push(`${scope} 指向的本地文件不存在：${localFilePath}`);
  }

  return normalized;
};

const hasProjectFile = (relativePath: string): boolean =>
  existsSync(join(process.cwd(), ...relativePath.split('/')));

const parseSocialCustomItem = (
  value: unknown,
  errors: string[],
  index: number
): SiteSocialCustomItem | null => {
  const scope = `site.socialLinks.custom[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${scope} 必须是对象`);
    return null;
  }

  collectUnknownKeys(scope, value, SOCIAL_CUSTOM_ITEM_KEYS, errors);

  const id = toTrimmedString(value.id);
  if (!id) errors.push(`${scope}.id 不能为空`);

  const label = toTrimmedString(value.label);
  if (!label) {
    errors.push(`${scope}.label 不能为空`);
  } else if (label.includes('\n') || label.includes('\r')) {
    errors.push(`${scope}.label 只允许单行文本`);
  }

  const href = toHttpsUrl(value.href);
  if (!href) errors.push(`${scope}.href 必须是合法 https:// 链接`);

  const iconKey = normalizeAdminSocialIconKey(value.iconKey);
  if (!iconKey) {
    errors.push(`${scope}.iconKey 必须来自白名单`);
  }

  const visible = toBoolean(value.visible);
  if (visible === undefined) errors.push(`${scope}.visible 必须是布尔值`);

  const order = toInteger(value.order);
  if (order === undefined) errors.push(`${scope}.order 必须是整数`);

  if (!id || !label || !href || !iconKey || visible === undefined || order === undefined) {
    return null;
  }

  return {
    id,
    label,
    href,
    iconKey,
    visible,
    order
  };
};

const parseHomeIntroLinks = (value: unknown, errors: string[]): HomeIntroLinkKey[] | null => {
  if (!Array.isArray(value)) {
    errors.push('home.introMoreLinks 必须是数组');
    return null;
  }

  if (value.length < 1 || value.length > ADMIN_HOME_INTRO_LINK_LIMIT) {
    errors.push(`home.introMoreLinks 必须包含 1-${ADMIN_HOME_INTRO_LINK_LIMIT} 个链接`);
  }

  const normalized: HomeIntroLinkKey[] = [];
  const seen = new Set<HomeIntroLinkKey>();

  value.forEach((item, index) => {
    const rawValue = toTrimmedString(item);
    if (!rawValue || !isAdminHomeIntroLinkKey(rawValue)) {
      errors.push(`home.introMoreLinks[${index}] 只允许 ${ADMIN_HOME_INTRO_LINK_KEYS.join(' / ')}`);
      return;
    }

    const linkKey = rawValue as HomeIntroLinkKey;
    if (seen.has(linkKey)) {
      errors.push(`home.introMoreLinks 不允许重复值：${linkKey}`);
      return;
    }

    seen.add(linkKey);
    normalized.push(linkKey);
  });

  if (normalized.length < 1 || normalized.length > ADMIN_HOME_INTRO_LINK_LIMIT) {
    return null;
  }

  return normalized;
};

const toWritableSiteSettings = (site: ThemeSettings['site']) => ({
  title: site.title,
  description: site.description,
  defaultLocale: site.defaultLocale,
  footer: { ...site.footer },
  socialLinks: {
    github: site.socialLinks.github,
    x: site.socialLinks.x,
    email: site.socialLinks.email,
    presetOrder: { ...site.socialLinks.presetOrder },
    custom: site.socialLinks.custom.map((item) => ({ ...item }))
  }
});

const parseNavItem = (value: unknown, errors: string[], index: number): NavInputItem | null => {
  if (!isRecord(value)) {
    errors.push(`shell.nav[${index}] 必须是对象`);
    return null;
  }

  collectUnknownKeys(`shell.nav[${index}]`, value, NAV_ITEM_KEYS, errors);

  const idRaw = toTrimmedString(value.id);
  if (!idRaw || !isAdminNavId(idRaw)) {
    errors.push(`shell.nav[${index}].id 非法`);
    return null;
  }
  const id = idRaw as SidebarNavId;

  const label = toTrimmedString(value.label);
  if (!label) errors.push(`shell.nav[${index}].label 不能为空`);

  let ornament: string | null = ADMIN_NAV_ORNAMENT_DEFAULT;
  if (Object.prototype.hasOwnProperty.call(value, 'ornament')) {
    const rawOrnament = value.ornament;
    if (rawOrnament === null) {
      ornament = null;
    } else if (typeof rawOrnament !== 'string') {
      errors.push(`shell.nav[${index}].ornament 必须是字符串、null 或留空`);
    } else {
      const trimmedOrnament = rawOrnament.trim();
      if (trimmedOrnament.includes('\n') || trimmedOrnament.includes('\r')) {
        errors.push(`shell.nav[${index}].ornament 只允许单行文本`);
      } else if (trimmedOrnament.length > ADMIN_NAV_ORNAMENT_MAX_LENGTH) {
        errors.push(`shell.nav[${index}].ornament 不能超过 ${ADMIN_NAV_ORNAMENT_MAX_LENGTH} 个字符`);
      } else {
        ornament = trimmedOrnament || null;
      }
    }
  }

  const visible = toBoolean(value.visible);
  if (visible === undefined) errors.push(`shell.nav[${index}].visible 必须是布尔值`);

  const order = toInteger(value.order);
  if (order === undefined || order < ADMIN_NAV_ORDER_MIN || order > ADMIN_NAV_ORDER_MAX) {
    errors.push(`shell.nav[${index}].order 必须是 ${ADMIN_NAV_ORDER_MIN}-${ADMIN_NAV_ORDER_MAX} 的整数`);
  }

  if (
    !label ||
    visible === undefined ||
    order === undefined ||
    order < ADMIN_NAV_ORDER_MIN ||
    order > ADMIN_NAV_ORDER_MAX
  ) {
    return null;
  }

  return { id, label, ornament, visible, order };
};

const applyTitle = (
  scope: string,
  input: Record<string, unknown>,
  target: { title: string | null },
  errors: string[]
): void => {
  if (!Object.prototype.hasOwnProperty.call(input, 'title')) {
    return;
  }

  const title = toNullableTrimmedString(input.title);
  if (title === undefined) {
    errors.push(`${scope}.title 必须是字符串、null 或留空`);
    return;
  }
  if (typeof title === 'string') {
    if (title.includes('\n') || title.includes('\r')) {
      errors.push(`${scope}.title 只允许单行文本`);
      return;
    }
    if (title.length > ADMIN_PAGE_TITLE_MAX_LENGTH) {
      errors.push(`${scope}.title 不能超过 ${ADMIN_PAGE_TITLE_MAX_LENGTH} 个字符`);
      return;
    }
  }

  target.title = title;
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
    if (subtitle.length > ADMIN_PAGE_SUBTITLE_MAX_LENGTH) {
      errors.push(`${scope}.subtitle 不能超过 ${ADMIN_PAGE_SUBTITLE_MAX_LENGTH} 个字符`);
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

const extractWriteInput = (
  input: unknown
): { settingsInput: unknown; revision: string | null; errors: string[] } => {
  if (!isRecord(input)) {
    return { settingsInput: null, revision: null, errors: ['请求体必须是 JSON 对象'] };
  }

  const revision = toTrimmedString(input.revision) ?? null;
  const errors = revision ? [] : ['请求体缺少 revision，请先同步最新配置后再保存'];

  if (Object.prototype.hasOwnProperty.call(input, 'settings')) {
    collectUnknownKeys('root', input, ['revision', 'settings'], errors);
    return { settingsInput: input.settings, revision, errors };
  }

  if (Object.prototype.hasOwnProperty.call(input, 'revision')) {
    const { revision: _revision, ...settingsInput } = input;
    return { settingsInput, revision, errors };
  }

  return { settingsInput: input, revision, errors };
};

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
        } else if (!ADMIN_LOCALE_RE.test(value)) {
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
          if (Object.prototype.hasOwnProperty.call(rawFooter, 'startYear')) {
            const value = toInteger(rawFooter.startYear);
            if (value === undefined) {
              errors.push('site.footer.startYear 必须是整数');
            } else if (value < ADMIN_FOOTER_START_YEAR_MIN || value > FOOTER_START_YEAR_MAX) {
              errors.push(
                `site.footer.startYear 必须在 ${ADMIN_FOOTER_START_YEAR_MIN}-${FOOTER_START_YEAR_MAX} 之间`
              );
            } else {
              nextSite.footer.startYear = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawFooter, 'showCurrentYear')) {
            const value = toBoolean(rawFooter.showCurrentYear);
            if (value === undefined) {
              errors.push('site.footer.showCurrentYear 必须是布尔值');
            } else {
              nextSite.footer.showCurrentYear = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawFooter, 'copyright')) {
            const value = toTrimmedString(rawFooter.copyright);
            if (!value) {
              errors.push('site.footer.copyright 不能为空');
            } else if (value.includes('\n') || value.includes('\r')) {
              errors.push('site.footer.copyright 只允许单行文本');
            } else if (value.length > ADMIN_FOOTER_COPYRIGHT_MAX_LENGTH) {
              errors.push(`site.footer.copyright 不能超过 ${ADMIN_FOOTER_COPYRIGHT_MAX_LENGTH} 个字符`);
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
            const value = toHttpsUrl(rawSocialLinks.github, ADMIN_GITHUB_HOSTS);
            if (value === undefined) {
              errors.push('site.socialLinks.github 只允许 https://github.com/... 或留空');
            } else {
              nextSite.socialLinks.github = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'x')) {
            const value = toHttpsUrl(rawSocialLinks.x, ADMIN_X_HOSTS);
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
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'presetOrder')) {
            const rawPresetOrder = rawSocialLinks.presetOrder;
            if (!isRecord(rawPresetOrder)) {
              errors.push('site.socialLinks.presetOrder 必须是对象');
            } else {
              const presetErrorsBefore = errors.length;
              collectUnknownKeys('site.socialLinks.presetOrder', rawPresetOrder, ADMIN_SOCIAL_PRESET_IDS, errors);

              const nextPresetOrder = { ...nextSite.socialLinks.presetOrder };
              for (const key of ADMIN_SOCIAL_PRESET_IDS) {
                if (!Object.prototype.hasOwnProperty.call(rawPresetOrder, key)) continue;
                const value = toInteger(rawPresetOrder[key]);
                if (value === undefined || value < ADMIN_SOCIAL_ORDER_MIN || value > ADMIN_SOCIAL_ORDER_MAX) {
                  errors.push(
                    `site.socialLinks.presetOrder.${key} 必须是 ${ADMIN_SOCIAL_ORDER_MIN}-${ADMIN_SOCIAL_ORDER_MAX} 的整数`
                  );
                } else {
                  nextPresetOrder[key] = value;
                }
              }

              if (errors.length === presetErrorsBefore) {
                nextSite.socialLinks.presetOrder = nextPresetOrder;
              }
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawSocialLinks, 'custom')) {
            const rawCustom = rawSocialLinks.custom;
            if (!Array.isArray(rawCustom)) {
              errors.push('site.socialLinks.custom 必须是数组');
            } else {
              const customErrorsBefore = errors.length;
              if (rawCustom.length > ADMIN_SOCIAL_CUSTOM_LIMIT) {
                errors.push(`site.socialLinks.custom 最多允许 ${ADMIN_SOCIAL_CUSTOM_LIMIT} 项`);
              }

              const parsedCustom = rawCustom
                .map((item, index) => parseSocialCustomItem(item, errors, index))
                .filter((item): item is SiteSocialCustomItem => item !== null);

              const seenIds = new Set<string>();
              for (const item of parsedCustom) {
                if (seenIds.has(item.id)) {
                  errors.push(`site.socialLinks.custom.id 重复：${item.id}`);
                }
                seenIds.add(item.id);
              }

              if (errors.length === customErrorsBefore) {
                nextSite.socialLinks.custom = parsedCustom.sort((a, b) => a.order - b.order);
              }
            }
          }

          const socialOrderIssues = getAdminSocialOrderIssues(
            nextSite.socialLinks.presetOrder,
            nextSite.socialLinks.custom.map((item, index) => ({
              key: String(index),
              order: item.order
            }))
          );

          socialOrderIssues.forEach((issue) => {
            if (issue.scope === 'preset') {
              if (issue.type === 'range') {
                errors.push(
                  `site.socialLinks.presetOrder.${issue.key} 必须是 ${ADMIN_SOCIAL_ORDER_MIN}-${ADMIN_SOCIAL_ORDER_MAX} 的整数`
                );
              } else {
                errors.push(`site.socialLinks.presetOrder.${issue.key} 与其他社交链接排序冲突：${issue.order}`);
              }
              return;
            }

            const index = Number.parseInt(issue.key, 10);
            if (!Number.isInteger(index)) return;

            if (issue.type === 'range') {
              errors.push(
                `site.socialLinks.custom[${index}].order 必须是 ${ADMIN_SOCIAL_ORDER_MIN}-${ADMIN_SOCIAL_ORDER_MAX} 的整数`
              );
              return;
            }

            errors.push(`site.socialLinks.custom[${index}].order 与其他社交链接排序冲突：${issue.order}`);
          });
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

          if (parsedNav.length === ADMIN_NAV_IDS.length) {
            const seenIds = new Set<SidebarNavId>();
            for (const row of parsedNav) {
              if (seenIds.has(row.id)) errors.push(`shell.nav ID 重复：${row.id}`);
              seenIds.add(row.id);
            }
            for (const navId of ADMIN_NAV_IDS) {
              if (!seenIds.has(navId)) {
                errors.push(`shell.nav 缺少导航项：${navId}`);
              }
            }

            getAdminNavOrderIssues(
              parsedNav.map((row) => ({
                key: row.id,
                order: row.order
              }))
            ).forEach((issue) => {
              if (issue.type === 'range') {
                errors.push(
                  `shell.nav.${issue.key}.order 必须是 ${ADMIN_NAV_ORDER_MIN}-${ADMIN_NAV_ORDER_MAX} 的整数`
                );
                return;
              }

              errors.push(`shell.nav.${issue.key}.order 与其他导航排序冲突：${issue.order}`);
            });

            nextShell.nav = parsedNav.sort((a, b) => {
              if (a.order !== b.order) return a.order - b.order;
              return ADMIN_NAV_IDS.indexOf(a.id) - ADMIN_NAV_IDS.indexOf(b.id);
            });
          } else if (rawNav.length !== ADMIN_NAV_IDS.length) {
            errors.push(`shell.nav 必须包含 ${ADMIN_NAV_IDS.length} 个既有导航项`);
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
      const nextHome = {
        ...current.home,
        introMoreLinks: [...current.home.introMoreLinks]
      };

      if (Object.prototype.hasOwnProperty.call(rawHome, 'introLead')) {
        const value = toTrimmedString(rawHome.introLead);
        if (!value) {
          errors.push('home.introLead 不能为空');
        } else if (value.length > ADMIN_HOME_INTRO_MAX_LENGTH) {
          errors.push(`home.introLead 不能超过 ${ADMIN_HOME_INTRO_MAX_LENGTH} 个字符`);
        } else {
          nextHome.introLead = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'introMore')) {
        const value = toTrimmedString(rawHome.introMore);
        if (!value) {
          errors.push('home.introMore 不能为空');
        } else if (value.length > ADMIN_HOME_INTRO_MAX_LENGTH) {
          errors.push(`home.introMore 不能超过 ${ADMIN_HOME_INTRO_MAX_LENGTH} 个字符`);
        } else {
          nextHome.introMore = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'introMoreLinks')) {
        const value = parseHomeIntroLinks(rawHome.introMoreLinks, errors);
        if (value) {
          nextHome.introMoreLinks = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'showIntroLead')) {
        const value = toBoolean(rawHome.showIntroLead);
        if (value === undefined) {
          errors.push('home.showIntroLead 必须是布尔值');
        } else {
          nextHome.showIntroLead = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'showIntroMore')) {
        const value = toBoolean(rawHome.showIntroMore);
        if (value === undefined) {
          errors.push('home.showIntroMore 必须是布尔值');
        } else {
          nextHome.showIntroMore = value;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'heroPresetId')) {
        const value = toTrimmedString(rawHome.heroPresetId);
        if (!value || !ADMIN_HERO_PRESET_SET.has(value as HeroPresetId)) {
          errors.push('home.heroPresetId 只允许 default/none');
        } else {
          nextHome.heroPresetId = value as HeroPresetId;
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'heroImageSrc')) {
        const value = normalizeAdminHeroImageSrc(rawHome.heroImageSrc);
        if (value === undefined) {
          errors.push('home.heroImageSrc 只允许 src/assets/**、public/**（或 / 开头路径）以及 https:// 图片地址');
        } else if (value === null) {
          nextHome.heroImageSrc = null;
        } else {
          const localFilePath = getAdminHeroImageLocalFilePath(value);
          if (localFilePath && !hasProjectFile(localFilePath)) {
            errors.push(`home.heroImageSrc 指向的本地文件不存在：${localFilePath}`);
          } else {
            nextHome.heroImageSrc = value;
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawHome, 'heroImageAlt')) {
        const value = toTrimmedString(rawHome.heroImageAlt);
        if (value === undefined) {
          errors.push('home.heroImageAlt 必须是字符串');
        } else if (value.includes('\n') || value.includes('\r')) {
          errors.push('home.heroImageAlt 只允许单行文本');
        } else if (value.length > ADMIN_HERO_IMAGE_ALT_MAX_LENGTH) {
          errors.push(`home.heroImageAlt 不能超过 ${ADMIN_HERO_IMAGE_ALT_MAX_LENGTH} 个字符`);
        } else {
          nextHome.heroImageAlt = value || ADMIN_HERO_IMAGE_ALT_DEFAULT;
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

      for (const pageId of ADMIN_PAGE_IDS) {
        if (!Object.prototype.hasOwnProperty.call(rawPage, pageId)) continue;
        const rawItem = rawPage[pageId];
        if (!isRecord(rawItem)) {
          errors.push(`page.${pageId} 必须是对象`);
          continue;
        }

        if (pageId === 'bits') {
          collectUnknownKeys(`page.${pageId}`, rawItem, BITS_PAGE_KEYS, errors);
          applyTitle(`page.${pageId}`, rawItem, nextPage.bits, errors);
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
                  nextPage.bits.defaultAuthor.avatar = validateBitsAvatarPath(
                    'page.bits.defaultAuthor.avatar',
                    value,
                    errors
                  );
                }
              }
            }
          }

          continue;
        }

        if (pageId === 'memo') {
          collectUnknownKeys(`page.${pageId}`, rawItem, MEMO_PAGE_KEYS, errors);
          applyTitle(`page.${pageId}`, rawItem, nextPage.memo, errors);
          applySubtitle(`page.${pageId}`, rawItem, nextPage.memo, errors);
          continue;
        }

        collectUnknownKeys(`page.${pageId}`, rawItem, PAGE_HEADING_KEYS, errors);
        applyTitle(`page.${pageId}`, rawItem, nextPage[pageId], errors);
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
        readingMode: { ...current.ui.readingMode },
        articleMeta: { ...current.ui.articleMeta },
        layout: {
          sidebarDivider: current.ui.layout.sidebarDivider ?? ADMIN_SIDEBAR_DIVIDER_DEFAULT
        }
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

      if (Object.prototype.hasOwnProperty.call(rawUi, 'articleMeta')) {
        const rawArticleMeta = rawUi.articleMeta;
        if (!isRecord(rawArticleMeta)) {
          errors.push('ui.articleMeta 必须是对象');
        } else {
          collectUnknownKeys('ui.articleMeta', rawArticleMeta, ARTICLE_META_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawArticleMeta, 'showDate')) {
            const value = toBoolean(rawArticleMeta.showDate);
            if (value === undefined) errors.push('ui.articleMeta.showDate 必须是布尔值');
            else nextUi.articleMeta.showDate = value;
          }
          if (Object.prototype.hasOwnProperty.call(rawArticleMeta, 'dateLabel')) {
            const value = toSingleLineTrimmedString(rawArticleMeta.dateLabel);
            if (value === undefined) {
              errors.push('ui.articleMeta.dateLabel 必须是单行字符串');
            } else if (value.length > ADMIN_ARTICLE_META_DATE_LABEL_MAX_LENGTH) {
              errors.push(`ui.articleMeta.dateLabel 不能超过 ${ADMIN_ARTICLE_META_DATE_LABEL_MAX_LENGTH} 个字符`);
            } else {
              nextUi.articleMeta.dateLabel = value;
            }
          }
          if (Object.prototype.hasOwnProperty.call(rawArticleMeta, 'showTags')) {
            const value = toBoolean(rawArticleMeta.showTags);
            if (value === undefined) errors.push('ui.articleMeta.showTags 必须是布尔值');
            else nextUi.articleMeta.showTags = value;
          }
          if (Object.prototype.hasOwnProperty.call(rawArticleMeta, 'showWordCount')) {
            const value = toBoolean(rawArticleMeta.showWordCount);
            if (value === undefined) errors.push('ui.articleMeta.showWordCount 必须是布尔值');
            else nextUi.articleMeta.showWordCount = value;
          }
          if (Object.prototype.hasOwnProperty.call(rawArticleMeta, 'showReadingTime')) {
            const value = toBoolean(rawArticleMeta.showReadingTime);
            if (value === undefined) errors.push('ui.articleMeta.showReadingTime 必须是布尔值');
            else nextUi.articleMeta.showReadingTime = value;
          }
        }
      }

      if (Object.prototype.hasOwnProperty.call(rawUi, 'layout')) {
        const rawLayout = rawUi.layout;
        if (!isRecord(rawLayout)) {
          errors.push('ui.layout 必须是对象');
        } else {
          collectUnknownKeys('ui.layout', rawLayout, LAYOUT_KEYS, errors);
          if (Object.prototype.hasOwnProperty.call(rawLayout, 'sidebarDivider')) {
            const value = toTrimmedString(rawLayout.sidebarDivider);
            if (!value || !isAdminSidebarDividerVariant(value)) {
              errors.push('ui.layout.sidebarDivider 只允许 default/subtle/none');
            } else {
              nextUi.layout.sidebarDivider = value;
            }
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

const createPersistEntries = (
  patch: Partial<ThemeSettings>,
  writtenGroups: readonly WritableGroup[]
): PersistEntry[] => {
  const entries: PersistEntry[] = [];

  if (patch.site && writtenGroups.includes('site')) {
    entries.push({
      group: 'site',
      filePath: SETTINGS_FILES.site,
      data: toWritableSiteSettings(patch.site)
    });
  }
  if (patch.shell && writtenGroups.includes('shell')) {
    entries.push({
      group: 'shell',
      filePath: SETTINGS_FILES.shell,
      data: patch.shell
    });
  }
  if (patch.home && writtenGroups.includes('home')) {
    entries.push({
      group: 'home',
      filePath: SETTINGS_FILES.home,
      data: patch.home
    });
  }
  if (patch.page && writtenGroups.includes('page')) {
    entries.push({
      group: 'page',
      filePath: SETTINGS_FILES.page,
      data: patch.page
    });
  }
  if (patch.ui && writtenGroups.includes('ui')) {
    entries.push({
      group: 'ui',
      filePath: SETTINGS_FILES.ui,
      data: patch.ui
    });
  }

  return entries;
};

const rollbackPersistOperations = async (operations: PersistOperation[]): Promise<void> => {
  for (const operation of [...operations].reverse()) {
    if (operation.committed) {
      await rm(operation.filePath, { force: true }).catch(() => undefined);
    }

    await rm(operation.tempPath, { force: true }).catch(() => undefined);

    if (operation.backupCreated) {
      await rename(operation.backupPath, operation.filePath).catch(() => undefined);
    }
  }
};

const cleanupPersistOperations = async (operations: PersistOperation[]): Promise<void> => {
  for (const operation of operations) {
    await rm(operation.tempPath, { force: true }).catch(() => undefined);
    if (operation.backupCreated) {
      await rm(operation.backupPath, { force: true }).catch(() => undefined);
    }
  }
};

const persistSettingsTransaction = async (entries: PersistEntry[]): Promise<WritableGroup[]> => {
  if (entries.length === 0) return [];

  await mkdir(SETTINGS_DIR, { recursive: true });

  const operations: PersistOperation[] = [];
  for (const entry of entries) {
    const tempPath = createTransientFilePath(entry.filePath, 'tmp');
    await writeFile(tempPath, createJsonBody(entry.data), 'utf8');
    operations.push({
      ...entry,
      tempPath,
      backupPath: createTransientFilePath(entry.filePath, 'bak'),
      existed: await fileExists(entry.filePath),
      committed: false,
      backupCreated: false
    });
  }

  try {
    for (const operation of operations) {
      if (operation.existed) {
        await rename(operation.filePath, operation.backupPath);
        operation.backupCreated = true;
      }

      await rename(operation.tempPath, operation.filePath);
      operation.committed = true;
    }
  } catch (error) {
    await rollbackPersistOperations(operations);
    throw error;
  }

  await cleanupPersistOperations(operations);
  return operations.map((operation) => operation.group);
};

// DEV 后台保存是低频操作，串行化写入可保证 revision 校验与实际提交处于同一临界区。
let adminSettingsWriteLock: Promise<void> = Promise.resolve();

const withAdminSettingsWriteLock = async <T>(task: () => Promise<T>): Promise<T> => {
  const previousLock = adminSettingsWriteLock;
  let releaseLock!: () => void;
  adminSettingsWriteLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await task();
  } finally {
    releaseLock();
  }
};

export const GET: APIRoute = async () => {
  if (!import.meta.env.DEV) {
    return DEV_ONLY_NOT_FOUND_RESPONSE.clone();
  }

  const payload = getEditableThemeSettingsState();
  return new Response(JSON.stringify(payload, null, 2), {
    status: payload.ok === false ? 500 : 200,
    headers: JSON_HEADERS
  });
};

export const POST: APIRoute = async ({ request, url }) => {
  if (!import.meta.env.DEV) {
    return DEV_ONLY_NOT_FOUND_RESPONSE.clone();
  }

  const isDryRun = isDryRunWriteRequest(url);
  const requestError = validateAdminWriteRequest(request, url);
  if (requestError) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          errors: [requestError.error],
          results: createResults([])
        },
        null,
        2
      ),
      { status: requestError.status, headers: JSON_HEADERS }
    );
  }

  let body: unknown;
  const rawBody = await request.text();
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

  try {
    body = JSON.parse(trimmedBody);
  } catch {
    return new Response(
      JSON.stringify({ ok: false, errors: ['请求体不是合法 JSON'] }, null, 2),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  const {
    settingsInput,
    revision,
    errors: writeInputErrors
  } = extractWriteInput(body);
  if (writeInputErrors.length) {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          errors: writeInputErrors,
          results: createResults([])
        },
        null,
        2
      ),
      { status: 400, headers: JSON_HEADERS }
    );
  }

  return withAdminSettingsWriteLock(async () => {
    const currentResolved = getThemeSettings();
    const editableState = getEditableThemeSettingsState(currentResolved);
    if (!editableState.ok) {
      return new Response(JSON.stringify(editableState, null, 2), {
        status: 409,
        headers: JSON_HEADERS
      });
    }

    const currentRevision = editableState.payload.revision;
    if (revision !== currentRevision) {
      resetThemeSettingsCache();
      const latestResolved = getThemeSettings();
      const latestEditableState = getEditableThemeSettingsState(latestResolved);
      if (!latestEditableState.ok) {
        return new Response(JSON.stringify(latestEditableState, null, 2), {
          status: 409,
          headers: JSON_HEADERS
        });
      }

      return new Response(
        JSON.stringify(
          {
            ok: false,
            errors: ['检测到配置已在外部更新，已拒绝覆盖并同步最新配置，请确认后再保存'],
            results: createResults([]),
            payload: latestEditableState.payload
          },
          null,
          2
        ),
        { status: 409, headers: JSON_HEADERS }
      );
    }

    const { patch, writtenGroups, errors } = parsePatch(settingsInput, currentResolved.settings);

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
    if (isDryRun) {
      return new Response(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            results
          },
          null,
          2
        ),
        { headers: JSON_HEADERS }
      );
    }

    const entries = createPersistEntries(patch, writtenGroups);

    try {
      const committedGroups = await persistSettingsTransaction(entries);
      for (const group of committedGroups) {
        results[group].written = true;
      }

      resetThemeSettingsCache();
      const latestResolved = getThemeSettings();
      const latestEditableState = getEditableThemeSettingsState(latestResolved);
      if (!latestEditableState.ok) {
        console.error('[astro-whono] Settings persisted but failed to reload editable payload:', latestEditableState);
        return new Response(
          JSON.stringify(
            {
              ok: false,
              errors: ['配置文件已写入，但重新读取 settings JSON 失败，请先修复损坏文件后再刷新后台'],
              results
            },
            null,
            2
          ),
          { status: 500, headers: JSON_HEADERS }
        );
      }

      return new Response(
        JSON.stringify(
          {
            ok: true,
            results,
            payload: latestEditableState.payload
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
  });
};
