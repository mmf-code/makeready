import type { MakeReadyMcpServices } from "./server";

/** Next after() acceleration complements the durable reconciler; reads remain side-effect free. */
export function accelerateMcpJobs(service: MakeReadyMcpServices, kickJob: (jobId: string) => void): MakeReadyMcpServices {
  return {
    ...service,
    async startDesign(input) {
      const result = await service.startDesign(input);
      kickJob(result.job.id);
      return result;
    },
    async executePlan(input) {
      const result = await service.executePlan(input);
      kickJob(result.id);
      return result;
    },
    async generateModel(input) {
      const result = await service.generateModel(input);
      kickJob(result.id);
      return result;
    },
  };
}
