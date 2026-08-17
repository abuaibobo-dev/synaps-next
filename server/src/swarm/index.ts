/**
 * Swarm Module - Ruflo-inspired multi-agent orchestration
 * 集成自适应拓扑、Agent 生命周期、蜂群协调、共识协议、学习闭环
 */

export { analyzeAndRecommend, inferCharacteristics, type Topology, type TaskCharacteristics } from './topology.js';
export { spawnAgent, listAgents, getAgentStatus, assignTask, completeTask, pauseAgent, resumeAgent, terminateAgent, getSwarmOverview, type SwarmAgent, type AgentLifecycleStatus } from './agentLifecycle.js';
export { initSwarm, populateSwarm, executeNextTask, reportTaskResult, getSwarmStatus, listSwarms, saveSwarmToDb, type SwarmSession, type SwarmTask } from './coordinator.js';
export { submitProposal, vote, applyProposal, getActiveProposals, getConflictLog, cleanupStaleProposals, type ConsensusProposal, type ConflictRecord } from './consensus.js';
export { recordExecution, analyzeAndSuggest, getLearningStats, type LearningRecord, type OptimizationSuggestion } from './learning.js';
