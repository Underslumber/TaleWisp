import { editImage } from "../models/gemini-flash-img.mjs";
import { geminiProVisionJSON } from "../models/gemini-pro.mjs";
import { loadPrompt } from "../utils/prompt-loader.mjs";
import {
  formatMapPlanSummary,
  formatRegionSummary,
} from "../utils/world-design-summary.mjs";

/**
 * Generate a walkable-area-marked version of the map using image editing mode.
 * Allows up to MAX_RETRIES modifications + 1 final review.
 * @param {Buffer} compressedMapBuffer - same-resolution optimized map used for model input
 * @param {string} userPrompt - user's map description for context
 * @param {object} worldDesign
 * @param {(name: string, data: any) => void} save
 * @returns {{ buffer: Buffer, reviewPassed: boolean, attempts: number }}
 */
export async function generateWalkableMap(compressedMapBuffer, userPrompt, worldDesign, save) {
  const MAX_RETRIES = parseInt(process.env.STEP4_MAX_RETRIES || process.env.MAX_RETRIES || "3", 10);
  const GENERATE_TIMEOUT_MS = parseInt(process.env.STEP4_GENERATE_TIMEOUT_MS || "180000", 10);
  const REVIEW_TIMEOUT_MS = parseInt(process.env.STEP4_REVIEW_TIMEOUT_MS || "90000", 10);
  let additionalInstructions = "";
  let markedBuffer = null;
  const totalAttempts = MAX_RETRIES + 1;
  const mapPlanSummary = formatMapPlanSummary(worldDesign);
  const regionSummary = formatRegionSummary(worldDesign);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    console.log(`[Step 4] Generating walkable area map (attempt ${attempt}/${totalAttempts})...`);

    const prompt = loadPrompt("step4-walkable-generation.md", {
      additionalInstructions,
      mapPlanSummary,
      regionSummary,
      userPrompt,
    });

    markedBuffer = await editImage(prompt, compressedMapBuffer, {
      imageSize: "1K",
      logStep: "Step 4 generate",
      requestTimeoutMs: GENERATE_TIMEOUT_MS,
    });
    console.log(`[Step 4] Generated marked image: ${markedBuffer.length} bytes`);
    save(`04-walkable-attempt-${attempt}.png`, markedBuffer);

    console.log(`[Step 4] Reviewing (${attempt}/${totalAttempts})...`);

    const reviewPrompt = loadPrompt("step4-walkable-review.md", {
      mapPlanSummary,
      regionSummary,
      userPrompt,
    });

    let review;
    let reviewError = null;
    try {
      review = await geminiProVisionJSON(reviewPrompt, [compressedMapBuffer, markedBuffer], {
        logStep: "Step 4 review",
        requestTimeoutMs: REVIEW_TIMEOUT_MS,
      });
    } catch (e) {
      reviewError = e;
      console.warn(`[Step 4] Review failed on attempt ${attempt}: ${e.message}`);
      review = { pass: false, issues: [`Review request failed: ${e.message}`], promptAdjustments: [] };
    }

    if (review.pass) {
      console.log("[Step 4] Review result: pass=true, issues=0");
      console.log(`[Step 4] Walkable area map passed review on attempt ${attempt}.`);
      return { buffer: markedBuffer, reviewPassed: true, attempts: attempt };
    }

    if (reviewError) {
      console.log(`[Step 4] Review unavailable on attempt ${attempt}, retrying generation.`);
      continue;
    }

    console.log(`[Step 4] Review failed. Issues: ${review.issues?.join("; ")}`);

    if (attempt < totalAttempts && review.promptAdjustments?.length) {
      additionalInstructions += `\n### 第${attempt}次审查反馈\n${review.promptAdjustments.join("\n")}`;
    }
  }

  console.warn(`[Step 4] All ${totalAttempts} attempts exhausted, review never passed.`);
  return { buffer: markedBuffer, reviewPassed: false, attempts: totalAttempts };
}
