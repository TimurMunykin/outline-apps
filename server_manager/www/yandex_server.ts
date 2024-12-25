import {sleep} from '@outline/infrastructure/sleep';
import {ValueStream} from '@outline/infrastructure/value_stream';

import {makePathApiClient} from './fetcher';
import {ShadowboxServer} from './shadowbox_server';
import * as yandex_api from '../cloud/yandex_api';
import {Zone} from '../model/yandex';
import * as server from '../model/server';
import {DataAmount, ManagedServerHost, MonetaryCost} from '../model/server';

enum InstallState {
  UNKNOWN = 0,
  INSTANCE_CREATED,
  IP_ALLOCATED,
  INSTANCE_RUNNING,
  CERTIFICATE_CREATED,
  COMPLETED,
  FAILED,
  CANCELED,
}

function getCompletionFraction(state: InstallState): number {
  switch (state) {
    case InstallState.UNKNOWN:
      return 0.01;
    case InstallState.INSTANCE_CREATED:
      return 0.12;
    case InstallState.IP_ALLOCATED:
      return 0.14;
    case InstallState.INSTANCE_RUNNING:
      return 0.4;
    case InstallState.CERTIFICATE_CREATED:
      return 0.7;
    case InstallState.COMPLETED:
      return 1.0;
    default:
      return 0;
  }
}

function isFinal(state: InstallState): boolean {
  return (
    state === InstallState.COMPLETED ||
    state === InstallState.FAILED ||
    state === InstallState.CANCELED
  );
}

export class YandexServer extends ShadowboxServer implements server.ManagedServer {
  private static readonly GUEST_ATTRIBUTES_POLLING_INTERVAL_MS = 5 * 1000;

  private readonly instanceReadiness: Promise<void>;
  private readonly yandexHost: YandexHost;
  private readonly installState = new ValueStream<InstallState>(InstallState.UNKNOWN);

  constructor(
    id: string,
    private locator: yandex_api.InstanceLocator,
    private yandexInstanceName: string,
    instanceCreation: Promise<unknown>,
    private apiClient: yandex_api.RestApiClient
  ) {
    super(id);
    const hasStaticIp: Promise<boolean> = this.hasStaticIp();
    this.instanceReadiness = instanceCreation
      .then(async () => {
        if (this.installState.isClosed()) {
          return;
        }
        this.setInstallState(InstallState.INSTANCE_CREATED);
        if (!(await hasStaticIp)) {
          await this.promoteEphemeralIp();
        }
        if (this.installState.isClosed()) {
          return;
        }
        this.setInstallState(InstallState.IP_ALLOCATED);
        this.pollInstallState();
      })
      .catch(e => {
        this.setInstallState(InstallState.FAILED);
        throw e;
      });
    this.yandexHost = new YandexHost(
      locator,
      yandexInstanceName,
      this.instanceReadiness,
      apiClient,
      this.onDelete.bind(this)
    );
  }

  private getRegionLocator(): yandex_api.RegionLocator {
    return {
      regionId: new Zone(this.locator.zoneId).regionId,
      projectId: this.locator.projectId,
    };
  }

  private async hasStaticIp(): Promise<boolean> {
    try {
      await this.apiClient.getStaticIp(
        this.getRegionLocator(),
        this.yandexInstanceName
      );
      return true;
    } catch (e) {
      if (is404(e)) {
        return false;
      }
      throw new server.ServerInstallFailedError(`Static IP check failed: ${e}`);
    }
  }

  private async promoteEphemeralIp(): Promise<void> {
    const instance = await this.apiClient.getInstance(this.locator);
    const ipAddress = instance.networkInterfaces[0].accessConfigs[0].natIP;
    const createStaticIpData = {
      name: instance.name,
      description: instance.description,
      address: ipAddress,
    };
    const createStaticIpOperation = await this.apiClient.createStaticIp(
      this.getRegionLocator(),
      createStaticIpData
    );
    const operationErrors = createStaticIpOperation.error?.errors;
    if (operationErrors) {
      throw new server.ServerInstallFailedError(
        `Firewall creation failed: ${operationErrors}`
      );
    }
  }

  getHost(): ManagedServerHost {
    return this.yandexHost;
  }

  async *monitorInstallProgress(): AsyncGenerator<number, void> {
    for await (const state of this.installState.watch()) {
      yield getCompletionFraction(state);
    }

    if (this.installState.get() === InstallState.FAILED) {
      throw new server.ServerInstallFailedError();
    } else if (this.installState.get() === InstallState.CANCELED) {
      throw new server.ServerInstallCanceledError();
    }
    yield getCompletionFraction(this.installState.get());
  }

  private async pollInstallState(): Promise<void> {
    while (!this.installState.isClosed()) {
      const outlineGuestAttributes = await this.getOutlineGuestAttributes();
      if (
        outlineGuestAttributes.has('apiUrl') &&
        outlineGuestAttributes.has('certSha256')
      ) {
        const certSha256 = outlineGuestAttributes.get('certSha256');
        const apiUrl = outlineGuestAttributes.get('apiUrl');
        this.setManagementApi(makePathApiClient(apiUrl, atob(certSha256)));
        this.setInstallState(InstallState.COMPLETED);
        break;
      } else if (outlineGuestAttributes.has('install-error')) {
        this.setInstallState(InstallState.FAILED);
        break;
      } else if (outlineGuestAttributes.has('certSha256')) {
        this.setInstallState(InstallState.CERTIFICATE_CREATED);
      } else if (outlineGuestAttributes.has('install-started')) {
        this.setInstallState(InstallState.INSTANCE_RUNNING);
      }

      await sleep(YandexServer.GUEST_ATTRIBUTES_POLLING_INTERVAL_MS);
    }
  }

  private async getOutlineGuestAttributes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const guestAttributes = await this.apiClient.getGuestAttributes(
      this.locator,
      'outline/'
    );
    const attributes = guestAttributes?.queryValue?.items ?? [];
    attributes.forEach(entry => {
      result.set(entry.key, entry.value);
    });
    return result;
  }

  private setInstallState(newState: InstallState): void {
    console.debug(InstallState[newState]);
    this.installState.set(newState);
    if (isFinal(newState)) {
      this.installState.close();
    }
  }

  private onDelete(): void {
    if (!this.installState.isClosed()) {
      this.setInstallState(InstallState.CANCELED);
    }
  }
}

class YandexHost implements server.ManagedServerHost {
  constructor(
    private readonly locator: yandex_api.InstanceLocator,
    private readonly yandexInstanceName: string,
    private readonly instanceReadiness: Promise<unknown>,
    private readonly apiClient: yandex_api.RestApiClient,
    private readonly deleteCallback: () => void
  ) {}

  async delete(): Promise<void> {
    this.deleteCallback();
    try {
      await this.instanceReadiness;
    } catch (e) {
      console.warn(`Attempting deletion of server that failed setup: ${e}`);
    }
    const regionLocator = {
      regionId: this.getCloudLocation().regionId,
      projectId: this.locator.projectId,
    };
    await this.waitForDelete(
      this.apiClient.deleteStaticIp(regionLocator, this.yandexInstanceName),
      'Deleted server did not have a static IP'
    );
    await this.waitForDelete(
      this.apiClient.deleteInstance(this.locator),
      'No instance for deleted server'
    );
  }

  private async waitForDelete(
    deletion: Promise<yandex_api.ComputeEngineOperation>,
    msg404: string
  ): Promise<void> {
    try {
      await deletion;
    } catch (e) {
      if (is404(e)) {
        console.warn(msg404);
        return;
      }
      throw e;
    }
  }

  getHostId(): string {
    return this.locator.instanceId;
  }

  getMonthlyCost(): MonetaryCost {
    return undefined;
  }

  getMonthlyOutboundTransferLimit(): DataAmount {
    return undefined;
  }

  getCloudLocation(): Zone {
    return new Zone(this.locator.zoneId);
  }
}

function is404(error: Error): boolean {
  return error instanceof yandex_api.HttpError && error.getStatusCode() === 404;
}
