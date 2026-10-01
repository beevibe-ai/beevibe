/**
 * The auth unit tests' mock repos. These used to be declared here; they now
 * live in `../port-fakes.ts`, which — unlike this file and every `*.test.ts`
 * — is included in the build, so `tsc` verifies each fake against its port.
 *
 * Re-exported rather than removed so the three auth test files keep their
 * existing import, and so there is one place to look for "the fakes" from
 * inside `auth/`.
 */
export {
  makeAgentRepoFake,
  makeCoreMemoryRepoFake,
  makeDaemonRepoFake,
  makePersonRepoFake,
} from "../port-fakes.js";
