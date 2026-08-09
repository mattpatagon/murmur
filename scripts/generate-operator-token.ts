#!/usr/bin/env bun

import { generateTokenSecret } from "../src/hosted/token-secret.js";

if (import.meta.main) process.stdout.write(generateTokenSecret("mur_op").secret);
