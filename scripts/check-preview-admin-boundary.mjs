import { pathToFileURL } from 'node:url';
import { preview } from 'astro';
import {
  assertAdminSettingsStaticResponse,
  findAvailablePort,
  waitForHttpReady
} from './smoke-utils.mjs';

const previewHost = '127.0.0.1';

const getRequestedPreviewPort = () => {
  const parsed = Number(process.env.CI_PREVIEW_PORT ?? '4323');
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4323;
};

const request = async (baseUrl, pathname, init = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text()
  };
};

const resolvePreviewPort = (server, fallbackPort) => {
  const address = server?.server?.address?.();
  return address && typeof address === 'object' ? address.port : fallbackPort;
};

export const runPreviewAdminBoundaryCheck = async () => {
  const requestedPort = getRequestedPreviewPort();
  const availablePort = await findAvailablePort(previewHost, requestedPort);
  if (availablePort !== requestedPort) {
    console.warn(
      `[check:preview-admin] Port ${requestedPort} is unavailable; using ${availablePort} instead.`
    );
  }

  const server = await preview({
    server: {
      host: previewHost,
      port: availablePort
    }
  });

  const previewPort = resolvePreviewPort(server, availablePort);
  const baseUrl = `http://${previewHost}:${previewPort}`;

  try {
    await waitForHttpReady(`${baseUrl}/`);

    const getResponse = await request(baseUrl, '/api/admin/settings/');
    const postResponse = await request(baseUrl, '/api/admin/settings/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl
      },
      body: JSON.stringify({ revision: 'invalid', settings: {} })
    });

    assertAdminSettingsStaticResponse('GET /api/admin/settings/', getResponse);
    assertAdminSettingsStaticResponse('POST /api/admin/settings/', postResponse);
    console.log('Preview admin settings boundary check passed.');
  } finally {
    await server.stop();
  }
};

const isDirectExecution = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isDirectExecution) {
  try {
    await runPreviewAdminBoundaryCheck();
  } catch (error) {
    console.error(error instanceof Error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
