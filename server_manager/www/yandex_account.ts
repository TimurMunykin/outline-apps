import {sleep} from '@outline/infrastructure/sleep';

import {YandexServer} from './yandex_server';
import * as server_install from './server_install';
import * as yandex_api from '../cloud/yandex_api';
import {SCRIPT} from '../install_scripts/yandex_install_script';
import * as yandex from '../model/yandex';
import {BillingAccount, Project} from '../model/yandex';
import * as server from '../model/server';

/** Returns a unique, RFC1035-style name as required by Yandex Compute Cloud. */
function makeYandexInstanceName(): string {
  function pad2(val: number) {
    return val.toString().padStart(2, '0');
  }

  const now = new Date();
  const year = now.getUTCFullYear().toString();
  const month = pad2(now.getUTCMonth() + 1); // January is month 0.
  const day = pad2(now.getUTCDate());
  const hour = pad2(now.getUTCHours());
  const minute = pad2(now.getUTCMinutes());
  const second = pad2(now.getUTCSeconds());
  return `outline-${year}${month}${day}-${hour}${minute}${second}`;
}

export function isInFreeTier(zone: yandex.Zone): boolean {
  // Implement logic to determine if the zone is in the free tier
  return false;
}

/**
 * The Yandex Cloud account model.
 */
export class YandexAccount implements yandex.Account {
  private static readonly OUTLINE_PROJECT_NAME = 'Outline servers';
  private static readonly OUTLINE_FIREWALL_NAME = 'outline';
  private static readonly OUTLINE_FIREWALL_TAG = 'outline';
  private static readonly MACHINE_SIZE = 'standard-v1';
  private static readonly REQUIRED_YANDEX_SERVICES = ['compute.cloud.yandex.net'];

  private readonly apiClient: yandex_api.RestApiClient;

  constructor(
    private id: string,
    private accessToken: string,
    private shadowboxSettings: server_install.ShadowboxSettings
  ) {
    this.apiClient = new yandex_api.RestApiClient(accessToken);
  }

  getId(): string {
    return this.id;
  }

  /** @see {@link Account#getName}. */
  async getName(): Promise<string> {
    const userInfo = await this.apiClient.getUserInfo();
    return userInfo?.email;
  }

  /** Returns the access token. */
  getAccessToken(): string {
    return this.accessToken;
  }

  /** @see {@link Account#listServers}. */
  async listServers(projectId: string): Promise<server.ManagedServer[]> {
    const result: YandexServer[] = [];
    const filter = 'labels.outline=true';
    const listAllInstancesResponse = await this.apiClient.listAllInstances(
      projectId,
      filter
    );
    const instanceMap = listAllInstancesResponse?.items ?? {};
    Object.values(instanceMap).forEach(({instances}) => {
      instances?.forEach(instance => {
        const {zoneId} = yandex_api.parseZoneUrl(instance.zone);
        const locator = {projectId, zoneId, instanceId: instance.id};
        const id = `${this.id}:${instance.id}`;
        result.push(
          new YandexServer(
            id,
            locator,
            instance.name,
            Promise.resolve(),
            this.apiClient
          )
        );
      });
    });
    return result;
  }

  /** @see {@link Account#listLocations}. */
  async listLocations(projectId: string): Promise<yandex.ZoneOption[]> {
    const listZonesResponse = await this.apiClient.listZones(projectId);
    const zones = listZonesResponse.items ?? [];
    return zones.map(zoneInfo => ({
      cloudLocation: new yandex.Zone(zoneInfo.name),
      available: zoneInfo.status === 'UP',
    }));
  }

  /** @see {@link Account#listProjects}. */
  async listProjects(): Promise<Project[]> {
    const filter = 'labels.outline=true AND lifecycleState=ACTIVE';
    const response = await this.apiClient.listProjects(filter);
    if (response.projects?.length > 0) {
      return response.projects.map(project => {
        return {
          id: project.projectId,
          name: project.name,
        };
      });
    }
    return [];
  }

  /** @see {@link Account#createProject}. */
  async createProject(
    projectId: string,
    billingAccountId: string
  ): Promise<Project> {
    // Create Yandex Cloud project
    const createProjectData = {
      projectId,
      name: YandexAccount.OUTLINE_PROJECT_NAME,
      labels: {
        outline: 'true',
      },
    };
    const createProjectResponse =
      await this.apiClient.createProject(createProjectData);
    let createProjectOperation = null;
    while (!createProjectOperation?.done) {
      await sleep(2 * 1000);
      createProjectOperation = await this.apiClient.resourceManagerOperationGet(
        createProjectResponse.name
      );
    }
    if (createProjectOperation.error) {
      // TODO: Throw error. The project wasn't created so we should have nothing to delete.
    }

    await this.configureProject(projectId, billingAccountId);

    return {
      id: projectId,
      name: YandexAccount.OUTLINE_PROJECT_NAME,
    };
  }

  async isProjectHealthy(projectId: string): Promise<boolean> {
    const projectBillingInfo =
      await this.apiClient.getProjectBillingInfo(projectId);
    if (!projectBillingInfo.billingEnabled) {
      return false;
    }

    const listEnabledServicesResponse =
      await this.apiClient.listEnabledServices(projectId);
    for (const requiredService of YandexAccount.REQUIRED_YANDEX_SERVICES) {
      const found = listEnabledServicesResponse.services.find(
        service => service.config.name === requiredService
      );
      if (!found) {
        return false;
      }
    }

    return true;
  }

  async repairProject(
    projectId: string,
    billingAccountId: string
  ): Promise<void> {
    return await this.configureProject(projectId, billingAccountId);
  }

  /** @see {@link Account#listBillingAccounts}. */
  async listOpenBillingAccounts(): Promise<BillingAccount[]> {
    const response = await this.apiClient.listBillingAccounts();
    if (response.billingAccounts?.length > 0) {
      return response.billingAccounts
        .filter(billingAccount => billingAccount.open)
        .map(billingAccount => ({
          id: billingAccount.name.substring(
            billingAccount.name.lastIndexOf('/') + 1
          ),
          name: billingAccount.displayName,
        }));
    }
    return [];
  }

  private async createFirewallIfNeeded(projectId: string): Promise<void> {
    // Configure Outline firewall
    const getFirewallResponse = await this.apiClient.listFirewalls(
      projectId,
      YandexAccount.OUTLINE_FIREWALL_NAME
    );
    if (
      !getFirewallResponse?.items ||
      getFirewallResponse?.items?.length === 0
    ) {
      const createFirewallData = {
        name: YandexAccount.OUTLINE_FIREWALL_NAME,
        direction: 'INGRESS',
        priority: 1000,
        targetTags: [YandexAccount.OUTLINE_FIREWALL_TAG],
        allowed: [
          {
            IPProtocol: 'all',
          },
        ],
        sourceRanges: ['0.0.0.0/0'],
      };
      const createFirewallOperation = await this.apiClient.createFirewall(
        projectId,
        createFirewallData
      );
      const errors = createFirewallOperation.error?.errors;
      if (errors) {
        throw new server.ServerInstallFailedError(
          `Firewall creation failed: ${errors}`
        );
      }
    }
  }

  /** @see {@link Account#createServer}. */
  async createServer(
    projectId: string,
    name: string,
    zone: yandex.Zone,
    metricsEnabled: boolean
  ): Promise<server.ManagedServer> {
    // TODO: Move this to project setup.
    await this.createFirewallIfNeeded(projectId);

    // Create VM instance
    const yandexInstanceName = makeYandexInstanceName();
    const createInstanceData = {
      name: yandexInstanceName,
      description: name, // Show a human-readable name in the Yandex Cloud console
      machineType: `zones/${zone.id}/machineTypes/${YandexAccount.MACHINE_SIZE}`,
      disks: [
        {
          boot: true,
          initializeParams: {
            sourceImage:
              'projects/ubuntu-os-cloud/global/images/family/ubuntu-2004-lts',
          },
        },
      ],
      networkInterfaces: [
        {
          network: 'global/networks/default',
          // Empty accessConfigs necessary to allocate ephemeral IP
          accessConfigs: [{}],
        },
      ],
      labels: {
        outline: 'true',
      },
      tags: {
        // This must match the firewall target tag.
        items: [YandexAccount.OUTLINE_FIREWALL_TAG],
      },
      metadata: {
        items: [
          {
            key: 'enable-guest-attributes',
            value: 'TRUE',
          },
          {
            key: 'user-data',
            value: this.getInstallScript(name, metricsEnabled),
          },
        ],
      },
    };
    const zoneLocator = {projectId, zoneId: zone.id};
    const createInstanceOperation = await this.apiClient.createInstance(
      zoneLocator,
      createInstanceData
    );
    const errors = createInstanceOperation.error?.errors;
    if (errors) {
      throw new server.ServerInstallFailedError(
        `Instance creation failed: ${errors}`
      );
    }

    const instanceId = createInstanceOperation.targetId;
    const instanceLocator = {instanceId, ...zoneLocator};
    const instanceCreation = this.apiClient.computeEngineOperationZoneWait(
      zoneLocator,
      createInstanceOperation.name
    );

    const id = `${this.id}:${instanceId}`;
    return new YandexServer(
      id,
      instanceLocator,
      yandexInstanceName,
      instanceCreation,
      this.apiClient
    );
  }

  private async configureProject(
    projectId: string,
    billingAccountId: string
  ): Promise<void> {
    // Link billing account
    const updateProjectBillingInfoData = {
      name: `projects/${projectId}/billingInfo`,
      projectId,
      billingAccountName: `billingAccounts/${billingAccountId}`,
    };
    await this.apiClient.updateProjectBillingInfo(
      projectId,
      updateProjectBillingInfoData
    );

    // Enable APIs
    const enableServicesData = {
      serviceIds: YandexAccount.REQUIRED_YANDEX_SERVICES,
    };
    const enableServicesResponse = await this.apiClient.enableServices(
      projectId,
      enableServicesData
    );
    let enableServicesOperation = null;
    while (!enableServicesOperation?.done) {
      await sleep(2 * 1000);
      enableServicesOperation = await this.apiClient.serviceUsageOperationGet(
        enableServicesResponse.name
      );
    }
    if (enableServicesResponse.error) {
      // TODO: Throw error.
    }
  }

  private getInstallScript(
    serverName: string,
    metricsEnabled: boolean
  ): string {
    return (
      '#!/bin/bash -eu\n' +
      server_install.getShellExportCommands(
        this.shadowboxSettings,
        serverName,
        metricsEnabled
      ) +
      SCRIPT
    );
  }
}
