/**
 * Secrets handling utilities for workflow definitions.
 * 
 * This module provides functionality to:
 * - Detect which interpolation expressions reference secrets
 * - Mask secret values in strings for safe logging
 * - Track secret values for encryption in storage
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// =============================================================================
// Constants
// =============================================================================

/** Mask string used to replace secret values in logs */
export const SECRET_MASK = "***";

/** Encryption algorithm used for storing secrets */
const ENCRYPTION_ALGORITHM = "aes-256-gcm";

/** Salt length for key derivation */
const SALT_LENGTH = 16;

/** IV length for encryption */
const IV_LENGTH = 12;

/** Auth tag length for GCM mode */
const AUTH_TAG_LENGTH = 16;

/** Minimum encryption key length for security */
const MIN_KEY_LENGTH = 16;

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for secrets handling in a workflow
 */
export interface SecretsConfig {
  /** List of input names that are marked as secrets */
  secretInputs: string[];
}

/**
 * Result from interpolation with secrets awareness
 */
export interface SecretAwareResult {
  /** The interpolated value (actual secret value) */
  value: string;
  /** The masked version safe for logging */
  masked: string;
  /** Whether this value contains any secrets */
  containsSecrets: boolean;
}

/**
 * Encrypted data structure stored in the database
 */
export interface EncryptedData {
  /** Indicates this is encrypted data */
  encrypted: true;
  /** Base64-encoded ciphertext with salt, iv, authTag, and data */
  data: string;
}

// =============================================================================
// Secret Detection
// =============================================================================

/**
 * Check if an interpolation expression references a secret value.
 * 
 * Rules:
 * - All env.* expressions are treated as secrets (environment variables often contain sensitive data)
 * - inputs.* expressions where the input name is in the secrets array
 * 
 * @param expression - The interpolation expression (e.g., "inputs.password", "env.API_KEY")
 * @param secretInputs - Array of input names marked as secrets
 * @returns true if the expression references a secret value
 */
export function isSecretExpression(expression: string, secretInputs: string[]): boolean {
  const trimmed = expression.trim();

  // All environment variables are treated as secrets
  if (trimmed.startsWith("env.")) {
    return true;
  }

  // Check if it's a secret input
  if (trimmed.startsWith("inputs.")) {
    const inputPath = trimmed.slice("inputs.".length);
    // Get the root input name (before any dots for nested access)
    const inputName = inputPath.split(".")[0];
    return secretInputs.includes(inputName);
  }

  return false;
}

/**
 * Extract all secret expressions from a template string.
 * 
 * @param template - Template string with {{expression}} placeholders
 * @param secretInputs - Array of input names marked as secrets
 * @returns Array of expressions that reference secrets
 */
export function extractSecretExpressions(template: string, secretInputs: string[]): string[] {
  const pattern = /\{\{([^}]+)\}\}/g;
  const secrets: string[] = [];

  for (const match of template.matchAll(pattern)) {
    const expression = match[1].trim();
    if (isSecretExpression(expression, secretInputs)) {
      secrets.push(expression);
    }
  }

  return secrets;
}

/**
 * Check if a template contains any secret references.
 * 
 * @param template - Template string to check
 * @param secretInputs - Array of input names marked as secrets
 * @returns true if template contains any secret references
 */
export function containsSecrets(template: string, secretInputs: string[]): boolean {
  return extractSecretExpressions(template, secretInputs).length > 0;
}

// =============================================================================
// Secret Masking
// =============================================================================

/**
 * Mask a secret value, showing only a hint of the original.
 * 
 * For short values (<=4 chars): completely masked
 * For longer values: shows first char + mask
 * 
 * @param value - The secret value to mask
 * @returns Masked representation safe for logging
 */
export function maskSecretValue(value: string): string {
  if (!value || value.length === 0) {
    return SECRET_MASK;
  }

  // For short values, completely mask
  if (value.length <= 4) {
    return SECRET_MASK;
  }

  // For longer values, show first character + mask
  return value[0] + SECRET_MASK;
}

/**
 * Create a masked version of an interpolated string.
 * Replaces all secret values with masked versions.
 * 
 * @param template - Original template string
 * @param interpolated - The interpolated result (with actual secret values)
 * @param secretValues - Map of secret expressions to their actual values
 * @returns Masked version of the interpolated string
 */
export function maskInterpolatedString(
  interpolated: string,
  secretValues: Map<string, string>
): string {
  let masked = interpolated;

  // Sort by value length (longest first) to handle overlapping values correctly
  const sortedSecrets = Array.from(secretValues.entries())
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [, value] of sortedSecrets) {
    if (value && value.length > 0) {
      // Replace all occurrences of the secret value with the mask
      masked = masked.split(value).join(SECRET_MASK);
    }
  }

  return masked;
}

// =============================================================================
// Encryption for Storage
// =============================================================================

/**
 * Validate encryption key meets minimum security requirements.
 * 
 * @param encryptionKey - The encryption key to validate
 * @throws Error if key is too short
 */
function validateEncryptionKey(encryptionKey: string): void {
  if (!encryptionKey || encryptionKey.length < MIN_KEY_LENGTH) {
    throw new Error(
      `Encryption key must be at least ${MIN_KEY_LENGTH} characters long for security. ` +
      `Provided key does not meet security requirements.`
    );
  }
}

/**
 * Derive an encryption key from a password/passphrase.
 * Uses scrypt for key derivation.
 * 
 * @param password - The password to derive key from
 * @param salt - Salt for key derivation
 * @returns 32-byte key for AES-256
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

/**
 * Encrypt sensitive data for storage.
 * Uses AES-256-GCM for authenticated encryption.
 * 
 * @param data - The sensitive data to encrypt
 * @param encryptionKey - The encryption key/password (minimum 16 characters)
 * @returns Encrypted data structure
 * @throws Error if encryption key is too short
 */
export function encryptForStorage(data: string, encryptionKey: string): EncryptedData {
  validateEncryptionKey(encryptionKey);

  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(encryptionKey, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(data, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Combine salt + iv + authTag + encrypted data
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);

  return {
    encrypted: true,
    data: combined.toString("base64"),
  };
}

/**
 * Decrypt data from storage.
 * 
 * @param encryptedData - The encrypted data structure
 * @param encryptionKey - The encryption key/password (minimum 16 characters)
 * @returns Decrypted string
 * @throws Error if encryption key is too short or decryption fails
 */
export function decryptFromStorage(encryptedData: EncryptedData, encryptionKey: string): string {
  validateEncryptionKey(encryptionKey);

  const combined = Buffer.from(encryptedData.data, "base64");

  // Extract components
  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = combined.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(encryptionKey, salt);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Check if a value is encrypted data.
 * 
 * @param value - The value to check
 * @returns true if this is an EncryptedData structure
 */
export function isEncryptedData(value: unknown): value is EncryptedData {
  return (
    typeof value === "object" &&
    value !== null &&
    "encrypted" in value &&
    (value as EncryptedData).encrypted === true &&
    "data" in value &&
    typeof (value as EncryptedData).data === "string"
  );
}

/**
 * Encrypt specific keys in an inputs object.
 * Only encrypts keys that are in the secrets list.
 * 
 * @param inputs - The workflow inputs
 * @param secretKeys - List of input keys that are secrets
 * @param encryptionKey - The encryption key
 * @returns New inputs object with secrets encrypted
 */
export function encryptSecretInputs(
  inputs: Record<string, unknown>,
  secretKeys: string[],
  encryptionKey: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    if (secretKeys.includes(key) && value !== undefined && value !== null) {
      // Encrypt the secret value
      const stringValue = typeof value === "string" ? value : JSON.stringify(value);
      result[key] = encryptForStorage(stringValue, encryptionKey);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Decrypt specific keys in an inputs object.
 * 
 * @param inputs - The workflow inputs (potentially with encrypted values)
 * @param encryptionKey - The encryption key
 * @returns New inputs object with secrets decrypted
 */
export function decryptSecretInputs(
  inputs: Record<string, unknown>,
  encryptionKey: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(inputs)) {
    if (isEncryptedData(value)) {
      try {
        const decrypted = decryptFromStorage(value, encryptionKey);
        // Try to parse as JSON (for non-string values that were stringified)
        try {
          result[key] = JSON.parse(decrypted);
        } catch {
          result[key] = decrypted;
        }
      } catch (error) {
        // Log warning for decryption failure - helps debug key rotation issues
        console.warn(`[secrets] Failed to decrypt input '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
        // Keep the encrypted value to avoid data loss
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
