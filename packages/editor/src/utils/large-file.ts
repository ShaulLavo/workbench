export const MI_CODE_UNITS = 1_048_576;
export const DEFAULT_MAX_ANALYSIS_BYTES = 2 * MI_CODE_UNITS;
export const DEFAULT_MAX_MINIMAP_BYTES = MI_CODE_UNITS;

export interface DocumentFeatureTierResult {
  readonly analysisAllowed: boolean;
  readonly minimapAllowed: boolean;
  readonly bitmask: number;
}

/** Returns true when a document's byte length is within the analysis threshold. */
export function documentAnalysisAllowed(
  byteLength: number,
  maxBytes: number = DEFAULT_MAX_ANALYSIS_BYTES,
): boolean {
  return byteLength <= maxBytes;
}

/** Computes analysis & minimap feature eligibility for large-file graceful degradation. */
export function documentFeatureTier(
  byteLength: number,
  maxAnalysisBytes: number = DEFAULT_MAX_ANALYSIS_BYTES,
  maxMinimapBytes: number = DEFAULT_MAX_MINIMAP_BYTES,
): DocumentFeatureTierResult {
  const analysisAllowed = documentAnalysisAllowed(byteLength, maxAnalysisBytes);
  const minimapAllowed = documentAnalysisAllowed(byteLength, maxMinimapBytes);
  return {
    analysisAllowed,
    minimapAllowed,
    bitmask: (analysisAllowed ? 1 : 0) | (minimapAllowed ? 2 : 0),
  };
}
