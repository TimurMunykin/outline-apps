import {YandexSession, RestApiSession, Account, InstanceInfo, RegionInfo, YandexInstanceSpecification} from '../cloud/yandex_api';

export class YandexAccount {
  private session: YandexSession;

  constructor(private accessToken: string) {
    this.session = new RestApiSession(accessToken);
  }

  public getAccessToken(): string {
    return this.accessToken;
  }

  public getAccount(): Promise<Account> {
    return this.session.getAccount();
  }

  public createInstance(
    displayName: string,
    region: string,
    publicKeyForSSH: string,
    instanceSpec: YandexInstanceSpecification
  ): Promise<{instance: InstanceInfo}> {
    return this.session.createInstance(displayName, region, publicKeyForSSH, instanceSpec);
  }

  public deleteInstance(instanceId: string): Promise<void> {
    return this.session.deleteInstance(instanceId);
  }

  public getRegionInfo(): Promise<RegionInfo[]> {
    return this.session.getRegionInfo();
  }

  public getInstance(instanceId: string): Promise<InstanceInfo> {
    return this.session.getInstance(instanceId);
  }

  public getInstanceTags(instanceId: string): Promise<string[]> {
    return this.session.getInstanceTags(instanceId);
  }

  public getInstancesByTag(tag: string): Promise<InstanceInfo[]> {
    return this.session.getInstancesByTag(tag);
  }

  public getInstances(): Promise<InstanceInfo[]> {
    return this.session.getInstances();
  }
}

export class YandexServer {
  constructor(private account: YandexAccount, private instanceInfo: InstanceInfo) {}

  public getId(): string {
    return this.instanceInfo.id;
  }

  public getStatus(): 'PROVISIONING' | 'RUNNING' | 'STOPPING' | 'STOPPED' {
    return this.instanceInfo.status;
  }

  public getTags(): string[] {
    return this.instanceInfo.tags;
  }

  public getZone(): {readonly id: string} {
    return this.instanceInfo.zone;
  }

  public getSize(): Readonly<{
    transfer: number;
    price_monthly: number;
  }> {
    return this.instanceInfo.size;
  }

  public getNetworkInterfaces(): Readonly<{
    primaryV4Address: Readonly<{
      address: string;
    }>;
  }> {
    return this.instanceInfo.networkInterfaces;
  }

  public async delete(): Promise<void> {
    await this.account.deleteInstance(this.instanceInfo.id);
  }
}

export {YandexAccount, YandexServer};
