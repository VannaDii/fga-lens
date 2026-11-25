import type { Tuple } from "@/lib/workbench-contract";

export const tide = "organization:tide";
export const coastal = "division:coastal";
export const inland = "division:inland";
export const islands = "division:islands";
export const shared = "division:shared";
export const campaign = "campaign:launch";
export const joint = "campaign:joint";
export const notice = "notice:bulletin";
export const attachment = "attachment:brief";
export const detached = "organization:detached";
export const inverse = "division:inverse";
export const unrelated = "organization:unrelated";
export const legacyOnly = "campaign:old-link";
export const editor = "user:sequoia-editor";
export const member = "user:sequoia-member";
export const remote = "user:sequoia-remote";
export const outerGroup = "group:sequoia-outer";
export const innerGroup = "group:sequoia-inner";
export const storedMarker = "synthetic-stored-region-82";
export const edgeMarker = "synthetic-stored-anchor-94";

/** Scope includes both diamond routes and a back edge. Only a former revision accepts the legacy link. */
export const reviewModel = [
  "model", "  schema 1.1", "",
  "type user", "",
  "type group", "  relations", "    define member: [user, group#member]", "",
  "type organization", "  relations",
  "    define include: [division]",
  "    define viewer: [user, group#member]",
  "    define can_view: viewer", "",
  "type division", "  relations",
  "    define parent: [organization, division with placed]",
  "    define can_view: can_view from parent", "",
  "type campaign", "  relations",
  "    define parent: [division]",
  "    define editor: [user]",
  "    define publisher: [user]",
  "    define blocked: [user]",
  "    define can_edit: editor",
  "    define can_view: can_view from parent",
  "    define publish: publisher",
  "    define can_publish: publisher but not blocked",
  "    define can_review: [user with region_match]", "",
  "type notice", "  relations",
  "    define parent: [division]",
  "    define signoff: [user, user:*]", "",
  "type attachment", "  relations",
  "    define parent: [division]", "",
  "condition placed(anchor: string) {",
  '  anchor != ""',
  "}", "",
  "condition region_match(region: string, allowed_region: string, delay: duration) {",
  '  region == allowed_region && delay >= duration("0s")',
  "}",
].join("\n");

export const oldReviewModel = reviewModel.replace(
  "type campaign\n  relations\n    define parent: [division]",
  "type campaign\n  relations\n    define parent: [division, organization]",
);

export const changedReviewModel = reviewModel.replace("define can_edit: editor", "define can_update: editor");

export const groupGrant = { user: outerGroup + "#member", relation: "viewer", object: tide };
export const nestedMembership = { user: innerGroup + "#member", relation: "member", object: outerGroup };
export const directMembership = { user: member, relation: "member", object: innerGroup };
export const directEdit = { user: editor, relation: "editor", object: campaign };
export const directParent = { user: coastal, relation: "parent", object: campaign };
export const outsideView = { user: remote, relation: "viewer", object: unrelated };
export const oldRevisionLink = { user: tide, relation: "parent", object: legacyOnly };

/** These concrete values validate stored conditions and act as markers for discovery redaction. */
const placed = { name: "placed", context: { anchor: edgeMarker } };
export const scopeTuples: Tuple[] = [
  { user: tide, relation: "parent", object: coastal },
  { user: tide, relation: "parent", object: inland },
  { user: tide, relation: "parent", object: islands },
  { user: coastal, relation: "parent", object: shared, condition: placed },
  { user: inland, relation: "parent", object: shared, condition: placed },
  { user: shared, relation: "parent", object: coastal, condition: placed },
  { user: inverse, relation: "include", object: tide },
  directParent,
  { user: shared, relation: "parent", object: joint },
  { user: editor, relation: "editor", object: joint },
  { user: inland, relation: "parent", object: notice },
  { user: islands, relation: "parent", object: attachment },
  { user: remote, relation: "viewer", object: detached },
  outsideView,
  groupGrant,
  nestedMembership,
  directMembership,
  directEdit,
  { user: editor, relation: "publisher", object: campaign },
  { user: editor, relation: "blocked", object: campaign },
  { user: editor, relation: "can_review", object: campaign,
    condition: { name: "region_match", context: { allowed_region: storedMarker, delay: "1s" } } },
  { user: "user:*", relation: "signoff", object: notice },
];

export const scopeObjects = [attachment, campaign, joint, notice, tide, coastal, inland, islands, shared].sort();
export const selectorObjects = [...scopeObjects, detached, inverse, unrelated, legacyOnly, editor, member, remote,
  outerGroup, innerGroup].sort();

export const parentLinks = [
  { objectType: "division", relation: "parent", subjectType: "organization", direction: "subject-to-object" },
  { objectType: "division", relation: "parent", subjectType: "division", direction: "subject-to-object" },
  { objectType: "campaign", relation: "parent", subjectType: "division", direction: "subject-to-object" },
  { objectType: "notice", relation: "parent", subjectType: "division", direction: "subject-to-object" },
  { objectType: "attachment", relation: "parent", subjectType: "division", direction: "subject-to-object" },
];
export const inverseLink = {
  objectType: "organization", relation: "include", subjectType: "division", direction: "object-to-subject",
};
