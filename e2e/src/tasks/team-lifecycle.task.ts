import { Ensure, equals, not } from '@serenity-js/assertions';
import { Check, Duration, Task, Wait } from '@serenity-js/core';
import { Click, Enter, isEnabled, isVisible } from '@serenity-js/web';
import {
  ArmTeamLifecycleMutation, CompleteTeamSkillPicker, ConfirmTeamCollection, ConfirmTeamLifecycleMutation,
  ConfirmTeamSkillUiReview, ConfirmUiCreatedTeam, PrepareTeamLifecycleCleanup, RecordTeamLifecycleResult,
  ReserveTeamLifecycle, ReviewTeamLifecycleSkill,
} from '../interactions/team-lifecycle.interaction.js';
import { TeamLifecyclePage } from '../pages/team-lifecycle.page.js';
import {
  OwnedTeamNeedsDeletion, OwnedTeamNeedsRunPurge, OwnedTeamResource, TeamCanvasIsReady, TeamLifecycleWasReserved, TeamListIsReady,
} from '../questions/team-lifecycle.question.js';
import { EnterChat } from './chat.task.js';

export const ReviewTrustedTeamSkill = () => Task.where('#actor checks a real trusted TeamSkill and its dependencies without installing anything',
  EnterChat(),
  ReviewTeamLifecycleSkill(),
);

const OpenTeams = () => Task.where('#actor opens the normal Teams UI from local Chat',
  EnterChat(),
  Click.on(TeamLifecyclePage.navigation),
  Wait.until(TeamLifecyclePage.heading, isVisible()),
  Wait.until(TeamListIsReady(), equals(true)),
);

export const CreateOwnedTeamThroughUi = () => Task.where('#actor creates one fresh UUID Team and its automatic first run through the real native picker UI',
  OpenTeams(),
  ReserveTeamLifecycle(),
  Click.on(TeamLifecyclePage.openCreate),
  Wait.until(TeamLifecyclePage.dialog, isVisible()),
  Enter.theValue(OwnedTeamResource().name).into(TeamLifecyclePage.name),
  Click.on(TeamLifecyclePage.loadSkill),
  Wait.until(TeamLifecyclePage.choosePackage, isEnabled()),
  Click.on(TeamLifecyclePage.choosePackage),
  Click.on(TeamLifecyclePage.chooseDirectory),
  CompleteTeamSkillPicker(),
  Wait.upTo(Duration.ofSeconds(45)).until(TeamLifecyclePage.packageIdentity, isVisible()),
  ConfirmTeamSkillUiReview(),
  Wait.until(TeamLifecyclePage.create, isEnabled()),
  ArmTeamLifecycleMutation('create-team'),
  Click.on(TeamLifecyclePage.create),
  Wait.upTo(Duration.ofSeconds(60)).until(TeamLifecyclePage.detailHeading(OwnedTeamResource().name), isVisible()),
  Wait.until(TeamLifecyclePage.runHistory, isEnabled()),
  ConfirmUiCreatedTeam(),
);

export const VerifyOwnedTeamCanvas = () => Task.where('#actor sees the real nonempty canvas and respects the created/intake stop gate without starting a model',
  Wait.upTo(Duration.ofSeconds(30)).until(TeamCanvasIsReady(), equals(true)),
  Wait.until(TeamLifecyclePage.deleteRun, isEnabled()),
  Ensure.that(TeamLifecyclePage.stopRun, isVisible()),
  Ensure.that(TeamLifecyclePage.stopRun, not(isEnabled())),
);

const DeleteOwnedRun = () => Task.where('#actor deletes only the confirmed automatic first run and observes same-call purge and public absence',
  Wait.until(TeamLifecyclePage.detailHeading(OwnedTeamResource().name), isVisible()),
  Wait.until(TeamLifecyclePage.deleteRun, isEnabled()),
  ArmTeamLifecycleMutation('purge-run'),
  Click.on(TeamLifecyclePage.deleteRun),
  ConfirmTeamLifecycleMutation(),
  Wait.until(TeamLifecyclePage.runHistory, not(isVisible())),
  Wait.until(TeamLifecyclePage.deleteRun, not(isEnabled())),
);

const ReturnToOwnTeamList = () => Task.where('#actor returns to the exact UUID Team without changing other teams',
  Click.on(TeamLifecyclePage.backToList),
  Wait.until(TeamLifecyclePage.heading, isVisible()),
  Wait.until(TeamLifecyclePage.teamRow(OwnedTeamResource().name), isVisible()),
  ConfirmTeamCollection(true),
);

const DeleteOwnedTeam = () => Task.where('#actor removes only the confirmed own Team after its run purge and observes same-call tombstone and UI absence',
  Wait.until(TeamLifecyclePage.deleteTeam(OwnedTeamResource().name), isEnabled()),
  ArmTeamLifecycleMutation('delete-team'),
  Click.on(TeamLifecyclePage.deleteTeam(OwnedTeamResource().name)),
  ConfirmTeamLifecycleMutation(),
  Wait.until(TeamLifecyclePage.teamRow(OwnedTeamResource().name), not(isVisible())),
  ConfirmTeamCollection(false),
);

export const DeleteOwnedTeamLifecycle = () => Task.where('#actor removes its confirmed run and Team through the UI without clearing foreign resources',
  DeleteOwnedRun(),
  ReturnToOwnTeamList(),
  DeleteOwnedTeam(),
  RecordTeamLifecycleResult(),
);

export const CleanupOwnedTeamLifecycle = () => Task.where('#actor cleans only settled confirmed own resources; unknown mutations stop cleanup without retry',
  Check.whether(TeamLifecycleWasReserved(), equals(true)).andIfSo(
    PrepareTeamLifecycleCleanup(),
    Check.whether(OwnedTeamNeedsRunPurge(), equals(true)).andIfSo(
      Check.whether(TeamLifecyclePage.detailHeading(OwnedTeamResource().name), isVisible()).andIfSo().otherwise(
        OpenTeams(),
        Click.on(TeamLifecyclePage.openTeam(OwnedTeamResource().name)),
      ),
      DeleteOwnedRun(),
    ),
    PrepareTeamLifecycleCleanup(),
    Check.whether(OwnedTeamNeedsDeletion(), equals(true)).andIfSo(
      Check.whether(TeamLifecyclePage.backToList, isVisible()).andIfSo(ReturnToOwnTeamList()).otherwise(OpenTeams()),
      DeleteOwnedTeam(),
    ),
  ),
);

export const RestoreTeamLifecycleUi = () => Task.where('#actor dismisses its unfinished create form and returns to usable Chat without touching business state',
  Check.whether(TeamLifecyclePage.dialog, isVisible()).andIfSo(
    Wait.until(TeamLifecyclePage.cancelDialog, isEnabled()),
    Click.on(TeamLifecyclePage.cancelDialog),
  ),
  EnterChat(),
);
