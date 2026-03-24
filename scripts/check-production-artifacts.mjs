import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'astro';
import { assertAdminSettingsStaticShell, expect } from './smoke-utils.mjs';

const DEFAULT_CI_SITE_URL = 'https://example.com';
const cliArgs = new Set(process.argv.slice(2));

const normalizeSiteUrl = (value) => value.trim().replace(/\/+$/, '');

export const resolveRequiredSiteUrl = () => {
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL ?? '');
  expect(siteUrl.length > 0, 'SITE_URL is required for production artifact verification');
  return siteUrl;
};

const readText = (filePath) => {
  expect(existsSync(filePath), `Expected build artifact is missing: ${filePath}`);
  return readFileSync(filePath, 'utf8');
};

export const runProductionArtifactCheck = async (options = {}) => {
  const siteUrl = options.siteUrl ?? resolveRequiredSiteUrl();

  const requiredArtifacts = [
    'dist/sitemap-index.xml',
    'dist/sitemap-0.xml',
    'dist/robots.txt',
    'dist/rss.xml',
    'dist/archive/rss.xml',
    'dist/essay/rss.xml',
    'dist/index.html',
    'dist/about/index.html',
    'dist/bits/index.html',
    'dist/api/admin/settings'
  ];

  for (const artifactPath of requiredArtifacts) {
    expect(existsSync(artifactPath), `Expected build artifact is missing: ${artifactPath}`);
  }

  const robotsTxt = readText('dist/robots.txt');
  expect(
    robotsTxt.includes(`Sitemap: ${siteUrl}/sitemap-index.xml`),
    'robots.txt is missing the expected Sitemap line'
  );

  const sitemapXml = readText('dist/sitemap-0.xml');
  expect(
    sitemapXml.includes(`<loc>${siteUrl}/about/</loc>`),
    'Sitemap is missing the expected /about/ location'
  );
  expect(!sitemapXml.includes('/admin/'), 'Admin route leaked into sitemap');
  expect(
    !sitemapXml.includes(`${siteUrl}/bits/draft-dialog/`),
    'Bits draft partial route leaked into sitemap'
  );

  const sitemapLocs = Array.from(
    sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g),
    (match) => match[1].trim()
  ).filter(Boolean);
  const leakedEssayDetail = sitemapLocs.find((loc) => /^\/essay\/[^/]+\/$/.test(new URL(loc).pathname));
  expect(!leakedEssayDetail, `Essay compatibility redirect leaked into sitemap: ${leakedEssayDetail}`);

  const aboutHtml = readText('dist/about/index.html');
  expect(
    aboutHtml.includes(`<link rel="canonical" href="${siteUrl}/about/"`),
    'About page canonical no longer matches SITE_URL'
  );
  expect(
    aboutHtml.includes(`<meta property="og:url" content="${siteUrl}/about/"`),
    'About page og:url no longer matches SITE_URL'
  );
  expect(!/\.admin-/.test(aboutHtml), 'Public about page still contains admin CSS rules');
  expect(!/--admin-status-/.test(aboutHtml), 'Public about page still contains admin CSS tokens');

  const indexHtml = readText('dist/index.html');
  expect(
    /<h1 class="sr-only">[^<]+<\/h1>/.test(indexHtml),
    'Homepage hidden H1 is missing from dist/index.html'
  );
  expect(
    /\.sr-only\s*\{/.test(indexHtml),
    'Homepage critical CSS is missing the .sr-only rule'
  );
  expect(
    /<link(?=[^>]+rel="preload")(?=[^>]+href="[^"]*global[^"]*")(?=[^>]+as="style")[^>]*>/.test(indexHtml),
    'Homepage is no longer preloading the deferred global stylesheet'
  );
  expect(
    /<link(?=[^>]+rel="stylesheet")(?=[^>]+href="[^"]*global[^"]*")(?=[^>]+media="print")(?=[^>]+onload="this\.onload=null;this\.media='all'")[^>]*>/.test(indexHtml),
    'Homepage is no longer using the deferGlobalStyles media-swap stylesheet path'
  );

  const pageSettings = existsSync('src/data/settings/page.json')
    ? JSON.parse(readFileSync('src/data/settings/page.json', 'utf8'))
    : null;
  const { site } = await import('../site.config.mjs');
  const rawAvatar = pageSettings?.bits?.defaultAuthor?.avatar ?? site.authorAvatar ?? 'author/avatar.webp';
  expect(
    typeof rawAvatar === 'string' && rawAvatar.trim().length > 0,
    'Bits default author avatar is missing from page settings / site config'
  );

  const normalizedAvatar = rawAvatar.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  const hasInvalidAvatarPath =
    normalizedAvatar.startsWith('/') ||
    normalizedAvatar.startsWith('//') ||
    normalizedAvatar.startsWith('public/') ||
    /^[A-Za-z]+:\/\//.test(normalizedAvatar) ||
    /(^|\/)\.\.(?:\/|$)/.test(normalizedAvatar) ||
    normalizedAvatar.includes('?') ||
    normalizedAvatar.includes('#');

  expect(
    !hasInvalidAvatarPath,
    `Bits default author avatar must stay a relative public/** image path: ${rawAvatar}`
  );
  expect(
    /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(normalizedAvatar),
    `Bits default author avatar must point to an image file: ${rawAvatar}`
  );

  const avatarFilePath = `public/${normalizedAvatar}`;
  expect(
    existsSync(avatarFilePath),
    `Bits default author avatar points to a missing file: ${avatarFilePath}`
  );

  const getRssItemLinks = (xml) =>
    Array.from(xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g), (match) => match[1].trim()).filter(Boolean);

  const normalizeArchiveDetailPath = (href) => {
    const url = new URL(href);
    const normalizedPath = url.pathname.replace(/\/+$/, '').replace(/^\/+/, '');
    expect(
      normalizedPath.startsWith('archive/') && normalizedPath.split('/').length >= 2,
      `Archive RSS item did not resolve to an /archive/{slug}/ detail page: ${href}`
    );
    return path.join('dist', normalizedPath, 'index.html');
  };

  const defaultRssXml = readText('dist/rss.xml');
  const archiveRssXml = readText('dist/archive/rss.xml');
  const essayRssXml = readText('dist/essay/rss.xml');

  const defaultRssLinks = getRssItemLinks(defaultRssXml);
  const archiveRssLinks = getRssItemLinks(archiveRssXml);
  const essayRssLinks = getRssItemLinks(essayRssXml);

  expect(archiveRssLinks.length > 0, 'Archive RSS does not contain any item links');
  expect(defaultRssLinks.length > 0, 'Default RSS does not contain any item links');
  expect(essayRssLinks.length > 0, 'Essay RSS does not contain any item links');

  const sampleArchiveLink = archiveRssLinks[0];
  expect(
    sampleArchiveLink.startsWith(`${siteUrl}/archive/`),
    `Archive RSS item link is not absolute or not under /archive/: ${sampleArchiveLink}`
  );
  expect(
    defaultRssLinks.includes(sampleArchiveLink),
    `Default RSS is missing archive item link: ${sampleArchiveLink}`
  );
  expect(
    essayRssLinks.includes(sampleArchiveLink),
    `Essay RSS is missing archive item link: ${sampleArchiveLink}`
  );
  expect(
    sitemapXml.includes(`<loc>${sampleArchiveLink}</loc>`),
    `Sitemap is missing archive detail link: ${sampleArchiveLink}`
  );

  const sampleArchiveHtmlPath = normalizeArchiveDetailPath(sampleArchiveLink);
  const sampleArchiveHtml = readText(sampleArchiveHtmlPath);
  expect(
    sampleArchiveHtml.includes(`<link rel="canonical" href="${sampleArchiveLink}"`),
    `Archive detail page canonical does not match RSS item link: ${sampleArchiveLink}`
  );
  expect(
    sampleArchiveHtml.includes(`<meta property="og:url" content="${sampleArchiveLink}"`),
    `Archive detail page og:url does not match RSS item link: ${sampleArchiveLink}`
  );
  expect(
    !/\.admin-/.test(sampleArchiveHtml),
    `Archive detail page still contains admin CSS rules: ${sampleArchiveHtmlPath}`
  );
  expect(
    !/--admin-status-/.test(sampleArchiveHtml),
    `Archive detail page still contains admin CSS tokens: ${sampleArchiveHtmlPath}`
  );

  const adminSettingsArtifact = readText('dist/api/admin/settings');
  assertAdminSettingsStaticShell('dist/api/admin/settings', adminSettingsArtifact);

  console.log('Production artifact verification passed.');
};

export const runProductionVerificationGate = async () => {
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL ?? '') || DEFAULT_CI_SITE_URL;
  process.env.SITE_URL = siteUrl;

  console.log(`[ci:prod] Building with SITE_URL=${siteUrl}`);
  await build({});
  await runProductionArtifactCheck({ siteUrl });

  const { runPreviewAdminBoundaryCheck } = await import('./check-preview-admin-boundary.mjs');
  await runPreviewAdminBoundaryCheck();

  console.log('Production verification gate passed.');
};

const isDirectExecution = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    if (cliArgs.has('--full-gate')) {
      await runProductionVerificationGate();
    } else {
      await runProductionArtifactCheck();
    }
  } catch (error) {
    console.error(error instanceof Error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
