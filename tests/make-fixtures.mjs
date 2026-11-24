import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const destination = process.argv[2];
if (!destination) throw new Error("Supply a disposable local directory for the synthetic fixtures");

const model = [
  "model",
  "  schema 1.1",
  "",
  "type user",
  "",
  "type group",
  "  relations",
  "    define member: [user]",
  "",
  "type organization",
  "  relations",
  "    define parent: [organization]",
  "    define member: [user, user with before_deadline]",
  "    define blocked: [user]",
  "    define eligible: member or eligible from parent",
  "    define can_read: eligible but not blocked",
  "    define audience: [user:*, group#member]",
  "",
  "condition before_deadline(current_time: timestamp, deadline: timestamp) {",
  "  current_time < deadline",
  "}",
  "",
].join("\n");

/** Makes synthetic data whose grants can be calculated independently of the application. */
function tuple(user, relation, object) {
  return { user, relation, object };
}

/** Gives the fixture more than one page of distinct, unrelated stored tuples. */
function supplementalTuples(count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const name = prefix + String(index).padStart(3, "0");
    return tuple("user:" + name, "member", "organization:" + name);
  });
}

const caseGrant = tuple("user:casey", "member", "organization:ca");
const timedMilestone = tuple("user:maya", "member", "organization:timed");
const shared = [
  tuple("organization:doordash", "parent", "organization:ca"),
  tuple("user:maya", "member", "organization:doordash"),
  tuple("user:casey", "member", "organization:unrelated"),
  tuple("group:studio#member", "audience", "organization:ca"),
  tuple("user:*", "audience", "organization:ca"),
  {
    ...timedMilestone,
    condition: { name: "before_deadline", context: { deadline: "2030-08-15T12:00:00Z" } },
  },
  ...supplementalTuples(102, "shared"),
];

/** Produces a single native check request with independent expected relations. */
function check(user, object, assertions, context = {}) {
  return { user, object, assertions, context };
}

const withGrant = {
  name: "Duplicate case",
  tuples: [caseGrant],
  check: [check("user:casey", "organization:ca", { can_read: true })],
  list_objects: [{
    user: "user:casey",
    type: "organization",
    assertions: { can_read: ["organization:unrelated", "organization:ca"] },
  }],
  list_users: [{
    object: "organization:ca",
    user_filter: [{ type: "user" }],
    assertions: { can_read: { users: ["user:casey", "user:maya"] } },
  }],
};

const withoutGrant = {
  name: "Duplicate case",
  check: [check("user:casey", "organization:ca", { can_read: false })],
  list_users: [
    {
      object: "organization:ca",
      user_filter: [{ type: "group", relation: "member" }],
      assertions: { audience: { users: ["group:studio#member"] } },
    },
    {
      object: "organization:ca",
      user_filter: [{ type: "user" }],
      assertions: { audience: { users: ["user:*"] } },
    },
  ],
};

const contextCase = {
  name: "Both sides of deadline",
  check: [
    check("user:maya", "organization:timed", { member: true, can_read: true },
      { current_time: "2030-08-15T11:59:59Z" }),
    check("user:maya", "organization:timed", { member: false, can_read: false },
      { current_time: "2030-08-15T12:00:01Z" }),
  ],
};

const boundary = {
  name: "Exactly 100 contextual tuples",
  tuples: supplementalTuples(100, "case"),
  check: [check("user:case000", "organization:case000", { can_read: true })],
};

const overflow = {
  ...boundary,
  name: "Reject 101 contextual tuples",
  tuples: supplementalTuples(101, "case"),
};

await mkdir(destination, { recursive: true });

/** JSON is valid YAML and preserves exact native scalar types without a generator dependency. */
async function writeYaml(name, contents) {
  await writeFile(join(destination, name), JSON.stringify(contents, null, 2) + "\n");
}

await Promise.all([
  writeFile(join(destination, "model.fga"), model),
  writeYaml("shared-tuples.yaml", shared),
  writeYaml("case-tuples.yaml", [caseGrant]),
  writeYaml("inline.fga.yaml", {
    name: "Workbench regression",
    model,
    tuples: shared,
    tests: [withGrant, withoutGrant, contextCase, boundary],
  }),
  writeYaml("relative.fga.yaml", {
    name: "Workbench regression",
    model_file: "./model.fga",
    tuple_file: "./shared-tuples.yaml",
    tests: [
      {
        name: withGrant.name,
        tuple_file: "./case-tuples.yaml",
        check: withGrant.check,
        list_objects: withGrant.list_objects,
        list_users: withGrant.list_users,
      },
      withoutGrant,
      contextCase,
    ],
  }),
  writeYaml("overflow.fga.yaml", {
    name: "Workbench contextual limit",
    model,
    tuples: shared,
    tests: [overflow],
  }),
]);
