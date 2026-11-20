import { WORKFLOW_AGENT } from "../job/messages.js";
import type { JobView } from "../job/tools.js";

/** 工作流里 agent() 派出的子代理不进任务清单：整次运行只占 workflow_run 那一行，停止也停那一行 */
export const workflowJobView: JobView = {
  refusal: (row) =>
    row.name === WORKFLOW_AGENT
      ? "This job is an agent started by a workflow run, not a plain job. Stop the whole run with job_stop on the workflow_run job."
      : null,
  lines: () => [],
};
