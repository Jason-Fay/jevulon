import { JevClient } from "./client.js";
import { validateChoice } from "./errors.js";

export interface ConfusionCase {
  input: string;
  expectedClass: string;
  predictedClass: string;
  confidence: number;
}

export interface MetacontrollerAudit {
  verdict: "keep_menu" | "revise_menu" | "investigate_data_pipeline";
  confidence: number;
  reason: string;
}

export class Metacontroller {
  private client: JevClient;

  constructor(client?: JevClient) {
    this.client = client || new JevClient();
  }

  /**
   * Audits routing confusion to determine if the decision menu is defective
   * or if the upstream data pipeline is feeding garbage (Exp 88).
   */
  public async auditConfusion(cases: ConfusionCase[]): Promise<MetacontrollerAudit> {
    const errorCount = cases.filter((c) => c.expectedClass !== c.predictedClass).length;
    const errorRate = cases.length > 0 ? errorCount / cases.length : 0;

    const state = {
      totalCases: cases.length,
      errorCount,
      errorRate: `${(errorRate * 100).toFixed(1)}%`,
      sampleErrors: cases
        .filter((c) => c.expectedClass !== c.predictedClass)
        .slice(0, 10),
    };

    const instructions =
      "Analyze the routing confusion cases. Determine whether the decision menu needs revision, or if the errors are symptoms of malformed/unparsed data pipeline input.";

    const criteria: Record<MetacontrollerAudit["verdict"], string> = {
      keep_menu: "The menu is performing within normal bounds; errors are acceptable edge cases.",
      revise_menu: "The menu definitions, descriptions, or keys are causing systematic misclassification.",
      investigate_data_pipeline: "The input data appears malformed, unparsed, or missing key evidence.",
    };

    const res = await this.client.choice(state, instructions, criteria);
    const verdicts = Object.keys(criteria) as Array<MetacontrollerAudit["verdict"]>; // keys of a Record<MetacontrollerAudit["verdict"], string>
    const verdict = validateChoice(res.choice, verdicts, "Metacontroller.auditConfusion");
    return {
      verdict,
      confidence: res.confidence,
      reason: `Auditor identified ${verdict} with ${(res.confidence * 100).toFixed(0)}% confidence.`,
    };
  }
}
