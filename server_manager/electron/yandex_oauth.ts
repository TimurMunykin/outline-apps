import {AddressInfo} from 'net';

import * as electron from 'electron';
import * as express from 'express';
import {OAuth2Client} from 'google-auth-library';

const OAUTH_CONFIG = {
  project_id: 'outline-manager-oauth',
  client_id: 'YOUR_YANDEX_OAUTH_CLIENT_ID',
  client_secret: 'YOUR_YANDEX_OAUTH_CLIENT_SECRET',
  scopes: [
    'https://cloud-api.yandex.net/iam/v1/tokens',
    'https://cloud-api.yandex.net/compute/v1/instances',
    'https://cloud-api.yandex.net/vpc/v1/networks',
    'https://cloud-api.yandex.net/functions/v1/functions',
    'https://cloud-api.yandex.net/storage/v1/buckets',
  ],
};
const REDIRECT_PATH = '/yandex/oauth/callback';

function responseHtml(messageHtml: string): string {
  return `<html><script>window.close()</script><body>${messageHtml}. You can close this window.</body></html>`;
}

async function verifyGrantedScopes(
  oAuthClient: OAuth2Client,
  accessToken: string
): Promise<boolean> {
  const getTokenInfoResponse = await oAuthClient.getTokenInfo(accessToken);
  for (const requiredScope of OAUTH_CONFIG.scopes) {
    const matchedScope = getTokenInfoResponse.scopes.find(
      grantedScope => grantedScope === requiredScope
    );
    if (!matchedScope) {
      return false;
    }
  }
  return true;
}

export function runOauth(): OauthSession {
  const app = express();
  const server = app.listen();
  const port = (server.address() as AddressInfo).port;

  const oAuthClient = new OAuth2Client(
    OAUTH_CONFIG.client_id,
    OAUTH_CONFIG.client_secret,
    `http://localhost:${port}${REDIRECT_PATH}`
  );
  const oAuthUrl = oAuthClient.generateAuthUrl({
    access_type: 'offline',
    scope: OAUTH_CONFIG.scopes,
  });
  electron.shell.openExternal(oAuthUrl);

  let isCancelled = false;
  const rejectWrapper = {reject: (_error: Error) => {}};
  const tokenPromise = new Promise<string>((resolve, reject) => {
    rejectWrapper.reject = reject;
    app.get(
      REDIRECT_PATH,
      async (request: express.Request, response: express.Response) => {
        if (request.query.error) {
          if (request.query.error === 'access_denied') {
            isCancelled = true;
            response.send(responseHtml('Authentication cancelled'));
            reject(new Error('Authentication cancelled'));
          } else {
            response.send(responseHtml('Authentication failed'));
            reject(
              new Error(
                `Authentication failed with error: ${request.query.error}`
              )
            );
          }
        } else {
          try {
            const getTokenResponse = await oAuthClient.getToken(
              request.query.code as string
            );
            if (getTokenResponse.res.status / 100 === 2) {
              const scopesValid = await verifyGrantedScopes(
                oAuthClient,
                getTokenResponse.tokens.access_token
              );
              if (!scopesValid) {
                console.error(
                  'Authentication failed with missing scope(s). Granted: ',
                  getTokenResponse.tokens.scope
                );
                response.send(
                  responseHtml('Authentication failed with missing scope(s)')
                );
                reject(
                  new Error('Authentication failed with missing scope(s)')
                );
              } else if (!getTokenResponse.tokens.refresh_token) {
                response.send(responseHtml('Authentication failed'));
                reject(
                  new Error('Authentication failed: Missing refresh token')
                );
              } else {
                response.send(responseHtml('Authentication successful'));
                resolve(getTokenResponse.tokens.refresh_token);
              }
            } else {
              response.send(responseHtml('Authentication failed'));
              reject(
                new Error(
                  `Authentication failed with HTTP status code: ${getTokenResponse.res.status}`
                )
              );
            }
          } catch (error) {
            response.send(responseHtml('Authentication failed'));
            reject(
              new Error(
                `Authentication failed with error: ${request.query.error}`
              )
            );
          }
        }
        server.close();
      }
    );
  });

  return {
    result: tokenPromise,
    isCancelled() {
      return isCancelled;
    },
    cancel() {
      console.log('Session cancelled');
      isCancelled = true;
      server.close();
      rejectWrapper.reject(new Error('Authentication cancelled'));
    },
  };
}
