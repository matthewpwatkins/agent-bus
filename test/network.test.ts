import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProfileToXml, relayAddressFor, type NetworkProfile } from "../src/network.js";

const SAMPLE = `<configuration version="52">
    <device id="AAA"></device>
    <options>
        <listenAddress>default</listenAddress>
        <globalAnnounceServer>default</globalAnnounceServer>
        <globalAnnounceEnabled>true</globalAnnounceEnabled>
        <localAnnounceEnabled>true</localAnnounceEnabled>
        <natEnabled>true</natEnabled>
        <urAccepted>0</urAccepted>
        <crashReportingEnabled>true</crashReportingEnabled>
        <autoUpgradeIntervalH>12</autoUpgradeIntervalH>
    </options>
</configuration>
`;

const PROFILE: NetworkProfile = { relay: "relay://203.0.113.7:22067", listenPort: 22000, appliedAt: "2026-01-01T00:00:00Z" };

test("hardened profile: discovery/NAT/reporting off, single pinned relay", () => {
  const out = applyProfileToXml(SAMPLE, PROFILE);
  assert.match(out, /<globalAnnounceEnabled>false<\/globalAnnounceEnabled>/);
  assert.match(out, /<localAnnounceEnabled>false<\/localAnnounceEnabled>/);
  assert.match(out, /<natEnabled>false<\/natEnabled>/);
  assert.match(out, /<crashReportingEnabled>false<\/crashReportingEnabled>/);
  assert.match(out, /<autoUpgradeIntervalH>0<\/autoUpgradeIntervalH>/);
  const listens = [...out.matchAll(/<listenAddress>([^<]+)<\/listenAddress>/g)].map((m) => m[1]);
  assert.deepEqual(listens, ["tcp://0.0.0.0:22000", "relay://203.0.113.7:22067"]);
  assert.ok(!out.includes("dynamic"), "no dynamic relay pool");
});

test("peer address goes through the pinned relay, addressed by the RELAY's id", () => {
  // ?id= is the relay server's device ID (Syncthing verifies it on dial);
  // using the peer's device ID here breaks every session ("relay id does
  // not match") -- regression test for the 2026-10-20 live failure.
  const withId: NetworkProfile = { ...PROFILE, relay: "relay://203.0.113.7:22067/?id=RELAYID" };
  assert.deepEqual(relayAddressFor(withId, "PEERDEVICEID"), ["relay://203.0.113.7:22067/?id=RELAYID"]);
  // No known relay ID: bare relay address (Syncthing skips the ID check).
  assert.deepEqual(relayAddressFor(PROFILE, "PEERDEVICEID"), ["relay://203.0.113.7:22067"]);
  assert.deepEqual(relayAddressFor(null, "PEERDEVICEID"), ["dynamic"]);
});
