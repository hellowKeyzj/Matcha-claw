export type CloudPackageMeteringBinding = Readonly<{
  id?: string;
  type?: string;
  unit?: string;
  amount?: number;
  currency?: string;
}>;

export type CloudPackageVersion = Readonly<{
  packageId: string;
  packageVersionId: string;
  name: string;
  displayName?: string;
  packageType: string;
  version: string;
  description?: string;
  status: string;
  entitlementStatus?: string;
  downloadable: boolean;
  meteringBinding?: CloudPackageMeteringBinding;
  downloadCount?: number;
  createdAt?: string;
  updatedAt?: string;
}>;

export type InstalledCloudPackage = Readonly<{
  packageVersionId: string;
  packageType: 'skill' | 'agent';
  packageSha256: string;
  fileName: string;
}>;

export type InstalledCloudPackageList = Readonly<{
  packages: InstalledCloudPackage[];
}>;

export type CloudPackageListPage = Readonly<{
  items: CloudPackageVersion[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}>;
