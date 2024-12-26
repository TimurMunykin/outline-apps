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
