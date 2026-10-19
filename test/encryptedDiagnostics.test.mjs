import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encryptDiagnostic,
  decryptDiagnostic,
  createTailCapture,
} from "../scripts/encrypted-diagnostics.mjs";
import { runPrivateCommand } from "../scripts/private-command.mjs";

const recipient = generateKeyPairSync("rsa", { modulusLength: 2048 });

test("failure diagnostics authenticate their encrypted body and recipient", () => {
  const packet = encryptDiagnostic(
    Buffer.from("private code and credential"),
    "compile",
    recipient.publicKey,
  );
  assert.doesNotMatch(JSON.stringify(packet), /private code|credential/);
  assert.equal(
    decryptDiagnostic(packet, recipient.privateKey).toString(),
    "private code and credential",
  );
  const damaged = { ...packet, ciphertext: Buffer.from("modified").toString("base64") };
  assert.throws(() => decryptDiagnostic(damaged, recipient.privateKey));
  assert.throws(() =>
    decryptDiagnostic(packet, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey),
  );
  assert.throws(() => decryptDiagnostic({ ...packet, stage: "install" }, recipient.privateKey));
});

test("private diagnostic capture keeps a bounded tail", () => {
  const capture = createTailCapture(8);
  capture.append(Buffer.from("12345"));
  capture.append(Buffer.from("6789"));
  assert.equal(capture.bytes().toString(), "23456789");
  capture.append(Buffer.from("abcdefghijklmnop"));
  assert.equal(capture.bytes().toString(), "ijklmnop");
});

test("failed child output is encrypted on disk and never printed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flatt-encrypted-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reports = [];
  await assert.rejects(
    runPrivateCommand(
      "compile",
      process.execPath,
      [
        "-e",
        "process.stderr.write('x'.repeat(3*1024*1024)); process.stderr.write('private source and fixture secret'); process.exit(1)",
      ],
      {
        report: (line) => reports.push(line),
        diagnostics: { directory, publicKey: recipient.publicKey },
      },
    ),
  );
  assert.doesNotMatch(reports.join("\n"), /private source|fixture secret/);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.enc\.json$/);
  const encrypted = await readFile(join(directory, files[0]), "utf8");
  assert.doesNotMatch(encrypted, /private source|fixture secret/);
  const plaintext = decryptDiagnostic(JSON.parse(encrypted), recipient.privateKey);
  assert.equal(plaintext.length, 2 * 1024 * 1024);
  assert.ok(plaintext.toString().endsWith("private source and fixture secret"));
});

test("successful child commands leave no diagnostic artifact", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flatt-success-diagnostic-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await runPrivateCommand(
    "compile",
    process.execPath,
    ["-e", "process.stdout.write('fixture private output')"],
    {
      report: () => {},
      diagnostics: { directory, publicKey: recipient.publicKey },
    },
  );
  assert.deepEqual(await readdir(directory), []);
});
