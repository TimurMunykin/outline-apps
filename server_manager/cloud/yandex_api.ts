import {CustomError} from '@outline/infrastructure/custom_error';

export interface YandexInstanceSpecification {
  installCommand: string;
  size: string;
  image: string;
  tags: string[];
}

export type InstanceInfo = Readonly<{
  id: string;
  status: 'PROVISIONING' | 'RUNNING' | 'STOPPING' | 'STOPPED';
  tags: string[];
  zone: {readonly id: string};
  size: Readonly<{
    transfer: number;
    price_monthly: number;
  }>;
  networkInterfaces: Readonly<{
    primaryV4Address: Readonly<{
      address: string;
    }>;
  }>;
}>;

export type Account = Readonly<{
  id: string;
  name: string;
  createdAt: string;
  status: 'ACTIVE' | 'INACTIVE';
}>;

export type RegionInfo = Readonly<{
  id: string;
  name: string;
  status: 'UP' | 'DOWN';
}>;

export class XhrError extends CustomError {
  constructor() {
    super();
  }
}

export interface YandexSession {
  accessToken: string;
  getAccount(): Promise<Account>;
  createInstance(
    displayName: string,
    region: string,
    publicKeyForSSH: string,
    instanceSpec: YandexInstanceSpecification
  ): Promise<{instance: InstanceInfo}>;
  deleteInstance(instanceId: string): Promise<void>;
  getRegionInfo(): Promise<RegionInfo[]>;
  getInstance(instanceId: string): Promise<InstanceInfo>;
  getInstanceTags(instanceId: string): Promise<string[]>;
  getInstancesByTag(tag: string): Promise<InstanceInfo[]>;
  getInstances(): Promise<InstanceInfo[]>;
}

export class RestApiSession implements YandexSession {
  constructor(public accessToken: string) {}

  public getAccount(): Promise<Account> {
    console.info('Requesting account');
    return this.request<{account: Account}>('GET', 'account').then(response => {
      return response.account;
    });
  }

  public createInstance(
    displayName: string,
    region: string,
    publicKeyForSSH: string,
    instanceSpec: YandexInstanceSpecification
  ): Promise<{instance: InstanceInfo}> {
    const instanceName = makeValidInstanceName(displayName);
    return this.registerKey_(instanceName, publicKeyForSSH).then(
      (keyId: string) => {
        return this.makeCreateInstanceRequest(
          instanceName,
          region,
          keyId,
          instanceSpec
        );
      }
    );
  }

  private makeCreateInstanceRequest(
    instanceName: string,
    region: string,
    keyId: string,
    instanceSpec: YandexInstanceSpecification
  ): Promise<{instance: InstanceInfo}> {
    let requestCount = 0;
    const MAX_REQUESTS = 10;
    const RETRY_TIMEOUT_MS = 5000;
    return new Promise((fulfill, reject) => {
      const makeRequestRecursive = () => {
        ++requestCount;
        console.info(
          `Requesting instance creation ${requestCount}/${MAX_REQUESTS}`
        );
        this.request<{instance: InstanceInfo}>('POST', 'instances', {
          name: instanceName,
          region,
          size: instanceSpec.size,
          image: instanceSpec.image,
          ssh_keys: [keyId],
          user_data: instanceSpec.installCommand,
          tags: instanceSpec.tags,
          ipv6: true,
        })
          .then(fulfill)
          .catch(e => {
            if (
              e.message.toLowerCase().indexOf('finalizing') >= 0 &&
              requestCount < MAX_REQUESTS
            ) {
              setTimeout(makeRequestRecursive, RETRY_TIMEOUT_MS);
            } else {
              reject(e);
            }
          });
      };
      makeRequestRecursive();
    });
  }

  public deleteInstance(instanceId: string): Promise<void> {
    console.info('Requesting instance deletion');
    return this.request<void>('DELETE', 'instances/' + instanceId);
  }

  public getRegionInfo(): Promise<RegionInfo[]> {
    console.info('Requesting region info');
    return this.request<{regions: RegionInfo[]}>('GET', 'regions').then(
      response => {
        return response.regions;
      }
    );
  }

  private registerKey_(
    keyName: string,
    publicKeyForSSH: string
  ): Promise<string> {
    console.info('Requesting key registration');
    return this.request<{ssh_key: {id: string}}>('POST', 'account/keys', {
      name: keyName,
      public_key: publicKeyForSSH,
    }).then(response => {
      return response.ssh_key.id;
    });
  }

  public getInstance(instanceId: string): Promise<InstanceInfo> {
    console.info('Requesting instance');
    return this.request<{instance: InstanceInfo}>(
      'GET',
      'instances/' + instanceId
    ).then(response => {
      return response.instance;
    });
  }

  public getInstanceTags(instanceId: string): Promise<string[]> {
    return this.getInstance(instanceId).then((instance: InstanceInfo) => {
      return instance.tags;
    });
  }

  public getInstancesByTag(tag: string): Promise<InstanceInfo[]> {
    console.info('Requesting instance by tag');
    return this.request<{instances: InstanceInfo[]}>(
      'GET',
      `instances?tag_name=${encodeURI(tag)}`
    ).then(response => {
      return response.instances;
    });
  }

  public getInstances(): Promise<InstanceInfo[]> {
    console.info('Requesting instances');
    return this.request<{instances: InstanceInfo[]}>('GET', 'instances').then(
      response => {
        return response.instances;
      }
    );
  }

  private request<T>(
    method: string,
    actionPath: string,
    data?: {}
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, `https://compute.api.cloud.yandex.net/compute/v1/${actionPath}`);
      xhr.setRequestHeader('Authorization', `Bearer ${this.accessToken}`);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status <= 299) {
          const responseObj = xhr.response ? JSON.parse(xhr.response) : {};
          resolve(responseObj);
        } else if (xhr.status === 401) {
          console.error('Yandex request failed with Unauthorized error');
          reject(new XhrError());
        } else {
          const responseJson = JSON.parse(xhr.response);
          console.error(
            `Yandex request failed with status ${xhr.status}`
          );
          reject(
            new Error(
              `XHR ${responseJson.id} failed with ${xhr.status}: ${responseJson.message}`
            )
          );
        }
      };
      xhr.onerror = () => {
        console.error('Failed to perform Yandex request');
        reject(new XhrError());
      };
      xhr.send(data ? JSON.stringify(data) : undefined);
    });
  }
}

function makeValidInstanceName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, '');
}

export class RestApiClient {
  private readonly YANDEX_HEADERS = new Map<string, string>([
    ['Content-type', 'application/json'],
    ['Accept', 'application/json'],
  ]);

  private accessToken: string;

  constructor(private refreshToken: string) {}

  async createInstance(
    zone: ZoneLocator,
    data: {}
  ): Promise<ComputeEngineOperation> {
    return this.fetchAuthenticated<ComputeEngineOperation>(
      'POST',
      new URL(`${zoneUrl(zone)}/instances`),
      this.YANDEX_HEADERS,
      null,
      data
    );
  }

  deleteInstance(instance: InstanceLocator): Promise<ComputeEngineOperation> {
    return this.fetchAuthenticated<ComputeEngineOperation>(
      'DELETE',
      new URL(instanceUrl(instance)),
      this.YANDEX_HEADERS
    );
  }

  getInstance(instance: InstanceLocator): Promise<Instance> {
    return this.fetchAuthenticated(
      'GET',
      new URL(instanceUrl(instance)),
      this.YANDEX_HEADERS
    );
  }

  listInstances(
    zone: ZoneLocator,
    filter?: string
  ): Promise<ListInstancesResponse> {
    let parameters = null;
    if (filter) {
      parameters = new Map<string, string>([['filter', filter]]);
    }
    return this.fetchAuthenticated(
      'GET',
      new URL(`${zoneUrl(zone)}/instances`),
      this.YANDEX_HEADERS,
      parameters
    );
  }

  listAllInstances(
    projectId: string,
    filter?: string
  ): Promise<ListAllInstancesResponse> {
    let parameters = null;
    if (filter) {
      parameters = new Map<string, string>([['filter', filter]]);
    }
    return this.fetchAuthenticated(
      'GET',
      new URL(`${projectUrl(projectId)}/aggregated/instances`),
      this.YANDEX_HEADERS,
      parameters
    );
  }

  async createStaticIp(
    region: RegionLocator,
    data: {}
  ): Promise<ComputeEngineOperation> {
    const operation = await this.fetchAuthenticated<ComputeEngineOperation>(
      'POST',
      new URL(`${regionUrl(region)}/addresses`),
      this.YANDEX_HEADERS,
      null,
      data
    );
    return await this.computeEngineOperationRegionWait(region, operation.name);
  }

  deleteStaticIp(
    region: RegionLocator,
    addressName: string
  ): Promise<ComputeEngineOperation> {
    return this.fetchAuthenticated<ComputeEngineOperation>(
      'DELETE',
      new URL(`${regionUrl(region)}/addresses/${addressName}`),
      this.YANDEX_HEADERS
    );
  }

  getStaticIp(region: RegionLocator, addressName: string): Promise<StaticIp> {
    return this.fetchAuthenticated<ComputeEngineOperation>(
      'GET',
      new URL(`${regionUrl(region)}/addresses/${addressName}`),
      this.YANDEX_HEADERS
    );
  }

  async getGuestAttributes(
    instance: InstanceLocator,
    namespace: string
  ): Promise<GuestAttributes | undefined> {
    try {
      const parameters = new Map<string, string>([['queryPath', namespace]]);
      return await this.fetchAuthenticated(
        'GET',
        new URL(`${instanceUrl(instance)}/getGuestAttributes`),
        this.YANDEX_HEADERS,
        parameters
      );
    } catch (error) {
      return undefined;
    }
  }

  async createFirewall(
    projectId: string,
    data: {}
  ): Promise<ComputeEngineOperation> {
    const operation = await this.fetchAuthenticated<ComputeEngineOperation>(
      'POST',
      new URL(`${projectUrl(projectId)}/global/firewalls`),
      this.YANDEX_HEADERS,
      null,
      data
    );
    return await this.computeEngineOperationGlobalWait(
      projectId,
      operation.name
    );
  }

  listFirewalls(
    projectId: string,
    name: string
  ): Promise<ListFirewallsResponse> {
    const filter = `name=${name}`;
    const parameters = new Map<string, string>([['filter', filter]]);
    return this.fetchAuthenticated(
      'GET',
      new URL(`${projectUrl(projectId)}/global/firewalls`),
      this.YANDEX_HEADERS,
      parameters
    );
  }

  listZones(projectId: string): Promise<ListZonesResponse> {
    return this.fetchAuthenticated(
      'GET',
      new URL(`${projectUrl(projectId)}/zones`),
      this.YANDEX_HEADERS
    );
  }

  listEnabledServices(projectId: string): Promise<ListEnabledServicesResponse> {
    const parameters = new Map<string, string>([['filter', 'state:ENABLED']]);
    return this.fetchAuthenticated(
      'GET',
      new URL(
        `https://serviceusage.googleapis.com/v1/projects/${projectId}/services`
      ),
      this.YANDEX_HEADERS,
      parameters
    );
  }

  enableServices(projectId: string, data: {}): Promise<ServiceUsageOperation> {
    return this.fetchAuthenticated(
      'POST',
      new URL(
        `https://serviceusage.googleapis.com/v1/projects/${projectId}/services:batchEnable`
      ),
      this.YANDEX_HEADERS,
      null,
      data
    );
  }

  createProject(data: {}): Promise<ResourceManagerOperation> {
    return this.fetchAuthenticated(
      'POST',
      new URL('https://cloudresourcemanager.googleapis.com/v1/projects'),
      this.YANDEX_HEADERS,
      null,
      data
    );
  }

  listProjects(filter?: string): Promise<ListProjectsResponse> {
    let parameters = null;
    if (filter) {
      parameters = new Map<string, string>([['filter', filter]]);
    }
    return this.fetchAuthenticated(
      'GET',
      new URL('https://cloudresourcemanager.googleapis.com/v1/projects'),
      this.YANDEX_HEADERS,
      parameters
    );
  }

  getProjectBillingInfo(projectId: string): Promise<ProjectBillingInfo> {
    return this.fetchAuthenticated(
      'GET',
      new URL(
        `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`
      ),
      this.YANDEX_HEADERS
    );
  }

  updateProjectBillingInfo(
    projectId: string,
    data: {}
  ): Promise<ProjectBillingInfo> {
    return this.fetchAuthenticated(
      'PUT',
      new URL(
        `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`
      ),
      this.YANDEX_HEADERS,
      null,
      data
    );
  }

  listBillingAccounts(): Promise<ListBillingAccountsResponse> {
    return this.fetchAuthenticated(
      'GET',
      new URL('https://cloudbilling.googleapis.com/v1/billingAccounts'),
      this.YANDEX_HEADERS
    );
  }

  async computeEngineOperationZoneWait(
    zone: ZoneLocator,
    operationId: string
  ): Promise<ComputeEngineOperation> {
    const operation = await this.fetchAuthenticated<ComputeEngineOperation>(
      'POST',
      new URL(`${zoneUrl(zone)}/operations/${operationId}/wait`),
      this.YANDEX_HEADERS
    );
    if (operation.error?.errors) {
      throw new GcpError(
        operation?.error.errors[0]?.code,
        operation?.error.errors[0]?.message
      );
    }
    return operation;
  }

  computeEngineOperationRegionWait(
    region: RegionLocator,
    operationId: string
  ): Promise<ComputeEngineOperation> {
    return this.fetchAuthenticated(
      'POST',
      new URL(`${regionUrl(region)}/operations/${operationId}/wait`),
      this.YANDEX_HEADERS
    );
  }

  computeEngineOperationGlobalWait(
    projectId: string,
    operationId: string
  ): Promise<ComputeEngineOperation> {
    return this.fetchAuthenticated(
      'POST',
      new URL(`${projectUrl(projectId)}/global/operations/${operationId}/wait`),
      this.YANDEX_HEADERS
    );
  }

  resourceManagerOperationGet(
    operationId: string
  ): Promise<ResourceManagerOperation> {
    return this.fetchAuthenticated(
      'GET',
      new URL(`https://cloudresourcemanager.googleapis.com/v1/${operationId}`),
      this.YANDEX_HEADERS
    );
  }

  serviceUsageOperationGet(
    operationId: string
  ): Promise<ServiceUsageOperation> {
    return this.fetchAuthenticated(
      'GET',
      new URL(`https://serviceusage.googleapis.com/v1/${operationId}`),
      this.YANDEX_HEADERS
    );
  }

  getUserInfo(): Promise<UserInfo> {
    return this.fetchAuthenticated(
      'POST',
      new URL('https://openidconnect.googleapis.com/v1/userinfo'),
      this.YANDEX_HEADERS
    );
  }

  private async refreshYandexAccessToken(refreshToken: string): Promise<string> {
    const headers = new Map<string, string>([
      ['Host', 'oauth2.googleapis.com'],
      ['Content-Type', 'application/x-www-form-urlencoded'],
    ]);
    const data = {
      client_id: GCP_OAUTH_CLIENT_ID,
      client_secret: GCP_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    const encodedData = this.encodeFormData(data);
    const response: RefreshAccessTokenResponse =
      await this.fetchUnauthenticated(
        'POST',
        new URL('https://oauth2.googleapis.com/token'),
        headers,
        null,
        encodedData
      );
    return response.access_token;
  }

  private async fetchAuthenticated<T>(
    method: string,
    url: URL,
    headers: Map<string, string>,
    parameters?: Map<string, string>,
    data?: any
  ): Promise<T> {
    const httpHeaders = new Map(headers);

    if (!this.accessToken) {
      this.accessToken = await this.refreshYandexAccessToken(this.refreshToken);
    }
    httpHeaders.set('Authorization', `Bearer ${this.accessToken}`);
    return this.fetchUnauthenticated(
      method,
      url,
      httpHeaders,
      parameters,
      data
    );
  }

  private async fetchUnauthenticated<T>(
    method: string,
    url: URL,
    headers: Map<string, string>,
    parameters?: Map<string, string>,
    data?: any
  ): Promise<T> {
    const customHeaders = new Headers();
    headers.forEach((value, key) => {
      customHeaders.append(key, value);
    });
    if (parameters) {
      parameters.forEach((value: string, key: string) =>
        url.searchParams.append(key, value)
      );
    }

    if (typeof data === 'object') {
      data = JSON.stringify(data);
    }

    const response = await fetch(url.toString(), {
      method: method.toUpperCase(),
      headers: customHeaders,
      ...(data && {body: data}),
    });

    if (!response.ok) {
      throw new HttpError(response.status, response.statusText);
    }

    try {
      let result = undefined;
      if (response.status !== 204) {
        result = await response.json();
      }
      return result;
    } catch (e) {
      throw new Error('Error parsing response body: ' + JSON.stringify(e));
    }
  }

  private encodeFormData(data: object): string {
    return Object.entries(data)
      .map(entry => {
        return (
          encodeURIComponent(entry[0]) + '=' + encodeURIComponent(entry[1])
        );
      })
      .join('&');
  }
}

export interface RegionLocator {
  projectId: string;
  regionId: string;
}

function regionUrl({projectId, regionId}: RegionLocator): string {
  return `${projectUrl(projectId)}/regions/${regionId}`;
}

export interface ZoneLocator {
  projectId: string;
  zoneId: string;
}

function zoneUrl({projectId, zoneId}: ZoneLocator): string {
  return `${projectUrl(projectId)}/zones/${zoneId}`;
}

const zoneUrlRegExp = new RegExp(
  '/compute/v1/projects/(?<projectId>[^/]+)/zones/(?<zoneId>[^/]+)$'
);

export function parseZoneUrl(url: string): ZoneLocator {
  const groups = new URL(url).pathname.match(zoneUrlRegExp).groups;
  return {
    projectId: groups['projectId'],
    zoneId: groups['zoneId'],
  };
}

export interface InstanceLocator extends ZoneLocator {
  instanceId: string;
}

function instanceUrl(instance: InstanceLocator): string {
  return `${zoneUrl(instance)}/instances/${instance.instanceId}`;
}
