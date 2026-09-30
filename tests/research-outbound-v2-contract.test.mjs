import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixtureDir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v2",
);
const fixtureV3Dir = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"outbound_v3",
);
const outbound = await import("../src/research-outbound-v2.ts");

async function fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"));
}

function manifestEntries(manifest) {
	return new Map(
		manifest
			.trim()
			.split(/\r?\n/)
			.map((line) => {
				const [digest, name] = line.split("  ");
				return [name, digest];
			}),
	);
}

async function v3Fixture(name) {
	return JSON.parse(await readFile(path.join(fixtureV3Dir, name), "utf8"));
}


test("manifest entries accept CRLF without retaining carriage returns", () => {
	const digest = "a".repeat(64);
	assert.deepEqual([...manifestEntries(`${digest}  object.json\r\n`)], [
		["object.json", digest],
	]);
});

test("C4 fixture directory exactly matches Research 55f2493 manifest", async () => {
	const names = (await readdir(fixtureDir)).sort();
	const manifest = await readFile(path.join(fixtureDir, "MANIFEST.sha256"), "utf8");
	const listed = manifestEntries(manifest);
	assert.deepEqual(names, ["MANIFEST.sha256", ...[...listed.keys()].sort()]);
	for (const [name, digest] of listed) {
		const bytes = await readFile(path.join(fixtureDir, name));
		const content = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
		assert.equal(createHash("sha256").update(content).digest("hex"), digest, name);
	}
});

test("C4 accepts every frozen outbound-v2 metadata and object envelope", async () => {
	for (const name of [
		"metadata_source.public.json",
		"metadata_source.private.json",
		"metadata_document_version.public.json",
		"metadata_document_version.private.json",
		"metadata_evidence.json",
		"metadata_coverage.json",
		"metadata_accumulator.json",
		"metadata_job.queued.json",
		"object_small.json",
		"object_chunked.json",
	]) {
		for (const record of await fixture(name)) {
			assert.deepEqual(await outbound.verifyOutboundV2Record(record), record, name);
		}
	}
});

test("C4 accepts every frozen outbound-v3 envelope without changing v2", async () => {
	const names = [
		"metadata_source.public.json",
		"metadata_source.private.json",
		"metadata_document_version.public.json",
		"metadata_document_version.private.json",
		"metadata_evidence.json",
		"metadata_coverage.json",
		"metadata_accumulator.json",
		"metadata_job.queued.json",
		"metadata_job.queued.trigger_evidence.json",
		"metadata_source_health.json",
		"object_small.json",
		"object_chunked.json",
	];
	for (const name of names) {
		for (const record of await fixtureV3(name)) {
			assert.equal(record.schema_version, outbound.OUTBOUND_V3_SCHEMA_VERSION);
			assert.deepEqual(await outbound.verifyOutboundV2Record(record), record, name);
		}
	}
	const manifest = await readFile(path.join(fixtureV3Dir, "MANIFEST.sha256"), "utf8");
	for (const [name, digest] of manifestEntries(manifest)) {
		assert.equal(
			createHash("sha256")
				.update(Buffer.from((await readFile(path.join(fixtureV3Dir, name))).toString("utf8").replace(/\r\n/g, "\n")))
				.digest("hex"),
			digest,
			name,
		);
	}
});

test("C4 preserves PUBLIC/PRIVATE, rejects INTERNAL, and does not accept hidden local fields", async () => {
	const publicSource = (await fixture("metadata_source.public.json"))[0];
	const privateSource = (await fixture("metadata_source.private.json"))[0];
	const hiddenKeys = await fixture("negative_hidden_keys.json");
	assert.equal(outbound.validateOutboundV2Record(publicSource).visibility, "PUBLIC");
	assert.equal(outbound.validateOutboundV2Record(privateSource).visibility, "PRIVATE");
	assert.throws(
		() => outbound.assertResearchVisibility("INTERNAL"),
		(error) => error?.error_code === "FILTERED",
	);
	assert.throws(
		() => outbound.assertOutboundV2PayloadSafe(hiddenKeys.input),
		(error) =>
			error?.error_code === "INTEGRITY_FAILED" &&
			!/planted|D:\\|\/home\//i.test(error.safe_message),
	);
});

test("C4 verifies replay, payload corruption, chunk corruption, and the frozen safe-error model", async () => {
	const replay = await fixture("replay_duplicate.json");
	assert.deepEqual(replay.records[0], replay.records[1]);
	assert.deepEqual(await outbound.verifyOutboundV2Record(replay.records[0]), replay.records[0]);

	const tamperedPayload = await fixture("corruption_tampered_payload.json");
	await assert.rejects(
		() => outbound.verifyOutboundV2Record(tamperedPayload.record),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);

	const tamperedChunk = await fixture("corruption_tampered_chunk.json");
	await assert.rejects(
		() =>
			outbound.verifyOutboundV2ObjectChunks(
				tamperedChunk.record,
				tamperedChunk.chunks_hex.map((chunk) => Buffer.from(chunk, "hex")),
			),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);

	for (const sample of (await fixture("error_model_samples.json")).samples) {
		assert.deepEqual(outbound.validateResearchError(sample), sample);
	}
});

test("C9 accepts v4 Evidence only with its complete immutable source reference and preserves v2/v3 exactness", async () => {
	const legacy = structuredClone((await fixture("metadata_evidence.json"))[0]);
	const document = (await fixture("metadata_document_version.public.json"))[0];
	const v4 = structuredClone(legacy);
	v4.schema_version = outbound.OUTBOUND_V4_SCHEMA_VERSION;
	v4.payload.source_reference = {
		document_id: document.payload.document.document_id,
		document_version_id: document.payload.version.version_id,
		attachment_id: null,
		content_sha256: "a".repeat(64),
		byte_start: 0,
		byte_end: 1,
		span_sha256: "b".repeat(64),
	};
	v4.payload.event_time = null;
	v4.payload.published_at = "2026-09-13T00:00:00Z";
	v4.payload.first_seen_at = "2026-09-13T00:01:00Z";
	v4.payload.ingested_at = "2026-09-13T00:02:00Z";
	v4.message_id = await outbound.computeOutboundV2MessageId(v4);
	assert.deepEqual(await outbound.verifyOutboundV2Record(v4), v4);

	const incomplete = structuredClone(v4);
	delete incomplete.payload.source_reference.span_sha256;
	await assert.rejects(
		() => outbound.verifyOutboundV2Record(incomplete),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	const contaminatedLegacy = structuredClone(legacy);
	contaminatedLegacy.schema_version = outbound.OUTBOUND_V3_SCHEMA_VERSION;
	contaminatedLegacy.payload.source_reference = structuredClone(v4.payload.source_reference);
	contaminatedLegacy.message_id = await outbound.computeOutboundV2MessageId(contaminatedLegacy);
	await assert.rejects(
		() => outbound.verifyOutboundV2Record(contaminatedLegacy),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

// ---------------------------------------------------------------------------
// #5 research-backend additions (§5.1 frozen v3 increment): the outbound_v3
// fixture directory is copied verbatim from the RESEARCH side and must
// recompute against the same MANIFEST; the compat window buckets record types
// per schema version; the v3 negatives pin the source_health whitelist and
// the v2 freeze.
// ---------------------------------------------------------------------------
const v3FixtureDir = path.join(fixtureDir, "..", "outbound_v3");

async function fixtureV3(name) {
	return JSON.parse(await readFile(path.join(v3FixtureDir, name), "utf8"));
}

test("#5 fixture directory exactly matches the frozen outbound_v3 MANIFEST", async () => {
	const names = (await readdir(v3FixtureDir)).sort();
	const manifest = await readFile(path.join(v3FixtureDir, "MANIFEST.sha256"), "utf8");
	const listed = manifestEntries(manifest);
	assert.deepEqual(names, ["MANIFEST.sha256", ...[...listed.keys()].sort()]);
	for (const [name, digest] of listed) {
		const bytes = await readFile(path.join(v3FixtureDir, name));
		const content = Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"));
		assert.equal(createHash("sha256").update(content).digest("hex"), digest, name);
	}
});

test("#5 accepts every frozen outbound-v3 envelope including source_health and trigger evidence", async () => {
	for (const name of [
		"metadata_source.public.json",
		"metadata_source.private.json",
		"metadata_document_version.public.json",
		"metadata_document_version.private.json",
		"metadata_evidence.json",
		"metadata_coverage.json",
		"metadata_accumulator.json",
		"metadata_job.queued.json",
		"metadata_job.queued.trigger_evidence.json",
		"metadata_source_health.json",
	]) {
		for (const record of await v3Fixture(name)) {
			assert.equal(record.schema_version, "collector-outbound-v3", name);
			assert.deepEqual(await outbound.verifyOutboundV2Record(record), record, name);
		}
	}
	// The health payload is exactly the ten whitelisted fields.
	const healthRows = await v3Fixture("metadata_source_health.json");
	assert.deepEqual(Object.keys(healthRows[0].payload).sort(), [
		"checked_at",
		"consecutive_failures",
		"failure_class",
		"last_error_code",
		"last_success_at",
		"outcome",
		"provider",
		"reachable",
		"source_id",
		"visibility",
	]);
});

test("#5 compat window: v2 envelope carrying source_health is UNSUPPORTED_OPERATION", async () => {
	const negative = await v3Fixture("negative_v2_envelope_with_source_health.json");
	assert.equal(negative.envelope.schema_version, "collector-outbound-v2");
	assert.equal(negative.envelope.record_type, "source_health");
	assert.throws(
		() => outbound.validateOutboundV2Record(negative.envelope),
		(error) => error?.error_code === "UNSUPPORTED_OPERATION",
	);
	// Mirror side of the window: a v3 envelope is accepted, and the same
	// health payload under v3 validates fine.
	const promoted = { ...negative.envelope, schema_version: "collector-outbound-v3" };
	promoted.message_id = await outbound.computeOutboundV2MessageId(promoted);
	await outbound.verifyOutboundV2Record(promoted);
});

test("#5 job generations: v2 exact-keys freezes out trigger_evidence_ids, v3 requires them", async () => {
	const v3Job = (await v3Fixture("metadata_job.queued.json"))[0];
	assert.deepEqual(await outbound.verifyOutboundV2Record(v3Job), v3Job);
	const triggerJob = (await v3Fixture("metadata_job.queued.trigger_evidence.json"))[0];
	assert.deepEqual(await outbound.verifyOutboundV2Record(triggerJob), triggerJob);

	// v2 job + trigger_evidence_ids -> rejected (frozen v2 exact-keys).
	const v2Job = JSON.parse(JSON.stringify(v3Job));
	v2Job.schema_version = "collector-outbound-v2";
	v2Job.message_id = await outbound.computeOutboundV2MessageId(v2Job);
	assert.throws(
		() => outbound.validateOutboundV2Record(v2Job),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	// v3 job without trigger_evidence_ids -> rejected (exact-keys).
	const withoutTrigger = JSON.parse(JSON.stringify(v3Job));
	delete withoutTrigger.payload.trigger_evidence_ids;
	withoutTrigger.message_id = await outbound.computeOutboundV2MessageId(withoutTrigger);
	assert.throws(
		() => outbound.validateOutboundV2Record(withoutTrigger),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	// v3 job with a non-string trigger id -> rejected.
	const badTrigger = JSON.parse(JSON.stringify(v3Job));
	badTrigger.payload.trigger_evidence_ids = [42];
	badTrigger.message_id = await outbound.computeOutboundV2MessageId(badTrigger);
	assert.throws(
		() => outbound.validateOutboundV2Record(badTrigger),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
});

test("#5 source_health negatives: float outcome and planted hidden keys never validate", async () => {
	const floatNegative = await v3Fixture("negative_health_float.json");
	const floatEnvelope = {
		record_type: "source_health",
		message_id: "pending",
		schema_version: "collector-outbound-v3",
		policy_version: "collector-policy-v1",
		visibility: "PUBLIC",
		payload: floatNegative.payload,
		generated_at: "2026-09-15T03:00:00+00:00",
	};
	floatEnvelope.message_id = await outbound.computeOutboundV2MessageId(floatEnvelope);
	assert.throws(
		() => outbound.validateOutboundV2Record(floatEnvelope),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);

	const hiddenKeys = await v3Fixture("negative_health_hidden_keys.json");
	// The planted input must fail the payload-safety scan...
	assert.throws(
		() => outbound.assertOutboundV2PayloadSafe(hiddenKeys.input),
		(error) => error?.error_code === "INTEGRITY_FAILED",
	);
	// ...while the stripped expected projection passes the ten-field gate.
	const cleanEnvelope = {
		record_type: "source_health",
		message_id: "pending",
		schema_version: "collector-outbound-v3",
		policy_version: "collector-policy-v1",
		visibility: "PUBLIC",
		payload: hiddenKeys.expected,
		generated_at: "2026-09-15T03:00:00+00:00",
	};
	cleanEnvelope.message_id = await outbound.computeOutboundV2MessageId(cleanEnvelope);
	await outbound.verifyOutboundV2Record(cleanEnvelope);
	// Frozen v2 fixture directory stays byte-identical in git; validated in
	// the manifest test above against its own MANIFEST.
});
