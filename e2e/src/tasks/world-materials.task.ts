import { Ensure, equals, includes } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, Select, isEnabled } from '@serenity-js/web';
import {
  ReadExactOrderMaterialSource, ReadRefreshedWorldMaterial, ReadWorldMaterialDraft, ReadWorldMaterialOperation, ReadWorldMaterialParse,
  ReadRetainedOrderMaterialUpload, ReadWorldMaterialUpload, RememberWorldMaterialsSession, SelectOwnWorldMaterialOperation,
  ReadWorldMaterialRejection, SelectWorldMaterialsPolicies, UploadOriginalWorldMaterial, UploadZeroModelWorldMaterial,
} from '../interactions/world-materials.interaction.js';
import { WorldMaterialsPage } from '../pages/world-materials.page.js';
import {
  WorldMaterialBudget, WorldMaterialCandidateRows, WorldMaterialOperationSettled, WorldMaterialReadbackText,
  WorldMaterialRejectionRequest, WorldMaterialUploadSettled, WorldMaterialsDraft, WorldMaterialsParsed, WorldMaterialsPreparation, WorldMaterialsRejection,
} from '../questions/world-materials.question.js';

export const ReadRetainedWorldOrderUpload = () => Task.where('#actor enters the existing World and reads only the retained original upload status',
  Click.on(WorldMaterialsPage.dataNavigation), Click.on(WorldMaterialsPage.materialsTab), ReadRetainedOrderMaterialUpload(),
);
export const ImportOriginalWorldMaterial = (kind: 'reimbursement' | 'order' = 'reimbursement') => Task.where('#actor imports original author bytes through the existing World UI once, or reads the retained original operation',
  Click.on(WorldMaterialsPage.settingsNavigation), Click.on(WorldMaterialsPage.operationsTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.session, isEnabled()), RememberWorldMaterialsSession(kind),
  Check.whether(WorldMaterialsPreparation().existing, equals(false)).andIfSo(
  Click.on(WorldMaterialsPage.dataNavigation), Click.on(WorldMaterialsPage.materialsTab), Click.on(WorldMaterialsPage.upload),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.scope, isEnabled()), SelectWorldMaterialsPolicies(),
  Click.on(WorldMaterialsPage.budgetSummary),
  Enter.theValue('90000').into(WorldMaterialsPage.wallTime), Enter.theValue('100').into(WorldMaterialsPage.steps),
  Enter.theValue('1').into(WorldMaterialsPage.sourceReads), Enter.theValue('1000').into(WorldMaterialsPage.rows),
  Enter.theValue('1048576').into(WorldMaterialsPage.bytes), Enter.theValue('1').into(WorldMaterialsPage.modelCalls),
  Enter.theValue('16000').into(WorldMaterialsPage.inputTokens), Enter.theValue('8000').into(WorldMaterialsPage.outputTokens),
  Ensure.that(WorldMaterialBudget(), equals(['90000', '100', '1', '1000', '1048576', '1', '16000', '8000'])),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.file, isEnabled()), UploadOriginalWorldMaterial(),
  Wait.upTo(Duration.ofSeconds(30)).until(WorldMaterialUploadSettled(), equals(true)), ReadWorldMaterialUpload(),
  ),
);
export const VerifyWorldMaterialProcessing = () => Task.where('#actor checks the same operation reached real Generation, extraction and final alignment rather than treating seal or acceptance as success',
  Click.on(WorldMaterialsPage.settingsNavigation), Click.on(WorldMaterialsPage.operationsTab),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.session, isEnabled()), SelectOwnWorldMaterialOperation(),
  Wait.upTo(Duration.ofSeconds(100)).until(WorldMaterialOperationSettled(), equals(true)), ReadWorldMaterialOperation(),
  ReadWorldMaterialParse(), ReadWorldMaterialDraft(),
  Ensure.that(WorldMaterialsPage.draftButtons.count(), equals(1)), Click.on(WorldMaterialsPage.draftButton),
  Click.on(WorldMaterialsPage.review),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialCandidateRows(), equals(WorldMaterialsDraft().candidates)),
);
export const ReadExactOrderMaterial = () => Task.where('#actor exposes the sole public exact43B SourceVersion only after real completed parsing and Generation/extraction',
  ReadExactOrderMaterialSource(),
  Check.whether(WorldMaterialsPage.closedReadback.count(), equals(1)).andIfSo(Click.on(WorldMaterialsPage.readbackSummary)),
  Select.value(WorldMaterialsParsed().sourceValue).from(WorldMaterialsPage.source), Click.on(WorldMaterialsPage.readSource),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialReadbackText(), includes(WorldMaterialsParsed().digest)),
  Ensure.that(WorldMaterialReadbackText(), includes(WorldMaterialsParsed().versionId)),
  Select.value(WorldMaterialsParsed().artifactId).from(WorldMaterialsPage.artifact), Click.on(WorldMaterialsPage.readArtifact),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialReadbackText(), includes('5997')),
  Ensure.that(WorldMaterialReadbackText(), includes('integer')),
);
export const ReadOriginalWorldMaterialInUi = () => Task.where('#actor reads original-version metadata and actual parsed text through the existing draft controls',
  Check.whether(WorldMaterialsPage.closedReadback.count(), equals(1)).andIfSo(Click.on(WorldMaterialsPage.readbackSummary)),
  Select.value(WorldMaterialsParsed().sourceValue).from(WorldMaterialsPage.source), Click.on(WorldMaterialsPage.readSource),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialReadbackText(), includes(WorldMaterialsParsed().digest)),
  Ensure.that(WorldMaterialReadbackText(), includes(WorldMaterialsParsed().versionId)),
  Select.value(WorldMaterialsParsed().artifactId).from(WorldMaterialsPage.artifact), Click.on(WorldMaterialsPage.readArtifact),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialReadbackText(), includes('报销申请必须附发票。')),
  Ensure.that(WorldMaterialReadbackText(), includes('单笔超过五百元须主管审批。')),
);
export const RejectZeroModelWorldMaterial = () => Task.where('#actor normally uploads one new synthetic material with zero model calls and verifies its own business rejection',
  Click.on(WorldMaterialsPage.dataNavigation), Click.on(WorldMaterialsPage.materialsTab), Click.on(WorldMaterialsPage.upload),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.scope, isEnabled()), SelectWorldMaterialsPolicies(),
  Click.on(WorldMaterialsPage.budgetSummary),
  Enter.theValue('90000').into(WorldMaterialsPage.wallTime), Enter.theValue('100').into(WorldMaterialsPage.steps),
  Enter.theValue('1').into(WorldMaterialsPage.sourceReads), Enter.theValue('1000').into(WorldMaterialsPage.rows),
  Enter.theValue('1048576').into(WorldMaterialsPage.bytes), Enter.theValue('0').into(WorldMaterialsPage.modelCalls),
  Enter.theValue('16000').into(WorldMaterialsPage.inputTokens), Enter.theValue('8000').into(WorldMaterialsPage.outputTokens),
  Ensure.that(WorldMaterialBudget(), equals(['90000', '100', '1', '1000', '1048576', '0', '16000', '8000'])),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.file, isEnabled()), UploadZeroModelWorldMaterial(),
  Check.whether(WorldMaterialsPage.closedRejectionDiagnostics.count(), equals(1)).andIfSo(Click.on(WorldMaterialsPage.rejectionDiagnosticSummary)),
  ReadWorldMaterialRejection(), Ensure.that(WorldMaterialRejectionRequest(), equals(WorldMaterialsRejection().requestId)),
);
export const RefreshWorldMaterialRejection = () => Task.where('#actor normally refreshes and reads the identical World/requestId/full Failure with no material import acceptance',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.refresh, isEnabled()), Click.on(WorldMaterialsPage.refresh),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.refresh, isEnabled()),
  Check.whether(WorldMaterialsPage.closedRejectionDiagnostics.count(), equals(1)).andIfSo(Click.on(WorldMaterialsPage.rejectionDiagnosticSummary)),
  ReadWorldMaterialRejection(true), Ensure.that(WorldMaterialRejectionRequest(), equals(WorldMaterialsRejection().requestId)),
);
export const RefreshWorldMaterialAndRead = () => Task.where('#actor refreshes normally and independently confirms the same persistent candidates, original version and evidence',
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.refresh, isEnabled()), Click.on(WorldMaterialsPage.refresh),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialsPage.refresh, isEnabled()),
  Wait.upTo(Duration.ofSeconds(15)).until(WorldMaterialCandidateRows(), equals(WorldMaterialsDraft().candidates)),
  ReadRefreshedWorldMaterial(), ReadOriginalWorldMaterialInUi(),
);
