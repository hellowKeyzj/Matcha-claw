import { Ensure, equals } from '@serenity-js/assertions';
import { test } from '../../fixtures/serenity.js';
import {
  NativeTemplateCatalogBoundary, PackageReadinessConsistency,
  RuntimeEnvironmentProjection, UnknownNativeTemplateRejection,
} from '../../questions/runtime-environment.question.js';
import {
  InspectNativeTemplateCatalogBoundary, InspectPackageReadiness,
  InspectRuntimeEnvironment, InspectUnknownNativeTemplateRejection,
} from '../../tasks/runtime-environment.task.js';

test('公开运行时环境提供安装状态且不泄露私密运行时字段', async ({ actor }) => {
  await actor.attemptsTo(
    InspectRuntimeEnvironment(),
    Ensure.that(RuntimeEnvironmentProjection(), equals({
      ipcOk: true, status: 200, httpOk: true,
      hasPackageExistsBoolean: true, hasIsBuiltBoolean: true,
      hasPrivateRuntimeFields: false,
    })),
  );
});

test('原生子代理模板目录不泄露私密字段，未知详情明确拒绝而非伪成功', async ({ actor }) => {
  await actor.attemptsTo(
    InspectNativeTemplateCatalogBoundary(),
    Ensure.that(NativeTemplateCatalogBoundary(), equals({
      ipcOk: true, status: 200, httpOk: true,
      hasCategoriesArray: true, hasTemplatesArray: true,
      missingTemplateIsAbsent: true, hasPrivateRuntimeFields: false,
    })),
    InspectUnknownNativeTemplateRejection(),
    Ensure.that(UnknownNativeTemplateRejection(), equals({
      ipcOk: true, status: 503, httpOk: false, successIsFalse: true,
      hasFixedPublicError: true, hasTemplate: false, hasPrivateRuntimeFields: false,
    })),
  );
});

test('公开 readiness 与环境安装状态一致且只返回布尔值', async ({ actor }) => {
  await actor.attemptsTo(
    InspectPackageReadiness(),
    Ensure.that(PackageReadinessConsistency(), equals({
      ipcOk: true, status: 200, httpOk: true, environmentIsAvailable: true,
      hasBooleanValue: true, matchesPackageExists: true, hasPrivateRuntimeFields: false,
    })),
  );
});
