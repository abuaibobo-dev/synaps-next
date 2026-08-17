/**
 * Consensus Protocol (Simplified Raft)
 * 借鉴 Ruflo raft-manager + byzantine-coordinator
 * 用于多 Agent 并行修改同一文件时的冲突解决
 */

import { randomUUID } from 'crypto';

export type ConsensusState = 'follower' | 'candidate' | 'leader';

export interface ConsensusProposal {
  id: string;
  swarmId: string;
  proposerAgentId: string;
  fileType: 'file_write' | 'file_delete' | 'config_change' | 'dependency_add';
  filePath: string;
  content: string;          // 变更内容摘要
  state: 'proposed' | 'voting' | 'accepted' | 'rejected' | 'applied';
  votes: Map<string, boolean>; // agentId → vote
  requiredVotes: number;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ConflictRecord {
  id: string;
  filePath: string;
  proposals: string[];      // proposal IDs
  resolution: 'first-wins' | 'merge' | 'manual' | 'reverted';
  resolvedBy: string | null;
  createdAt: string;
}

const ACTIVE_PROPOSALS = new Map<string, ConsensusProposal>();
const CONFLICT_LOG: ConflictRecord[] = [];

/**
 * 提交变更提案
 */
export function submitProposal(
  swarmId: string,
  agentId: string,
  fileType: ConsensusProposal['fileType'],
  filePath: string,
  contentSummary: string,
  requiredVotes: number = 1,
): ConsensusProposal {
  // 检查是否有冲突
  const existingProposal = findActiveProposalForFile(filePath);
  if (existingProposal && existingProposal.swarmId !== swarmId) {
    // 不同 swarm 的冲突 → 记录并按先到先得解决
    const conflict: ConflictRecord = {
      id: randomUUID(),
      filePath,
      proposals: [existingProposal.id],
      resolution: 'first-wins',
      resolvedBy: null,
      createdAt: new Date().toISOString(),
    };
    CONFLICT_LOG.push(conflict);
    existingProposal.state = 'applied'; // 先到的赢
  }

  const proposal: ConsensusProposal = {
    id: randomUUID(),
    swarmId,
    proposerAgentId: agentId,
    fileType,
    filePath,
    content: contentSummary,
    state: requiredVotes > 1 ? 'voting' : 'proposed',
    votes: new Map(),
    requiredVotes,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };

  ACTIVE_PROPOSALS.set(proposal.id, proposal);
  return proposal;
}

/**
 * 投票
 */
export function vote(proposalId: string, agentId: string, approve: boolean): {
  accepted: boolean;
  totalVotes: number;
  requiredVotes: number;
} {
  const proposal = ACTIVE_PROPOSALS.get(proposalId);
  if (!proposal || proposal.state === 'applied' || proposal.state === 'rejected') {
    return { accepted: false, totalVotes: 0, requiredVotes: 0 };
  }

  proposal.votes.set(agentId, approve);

  const approveCount = Array.from(proposal.votes.values()).filter(v => v).length;
  const rejectCount = Array.from(proposal.votes.values()).filter(v => !v).length;

  // 多数决
  if (approveCount >= proposal.requiredVotes) {
    proposal.state = 'accepted';
    proposal.resolvedAt = new Date().toISOString();
    return { accepted: true, totalVotes: proposal.votes.size, requiredVotes: proposal.requiredVotes };
  }

  // 多数拒绝
  if (rejectCount > proposal.requiredVotes) {
    proposal.state = 'rejected';
    proposal.resolvedAt = new Date().toISOString();
    return { accepted: false, totalVotes: proposal.votes.size, requiredVotes: proposal.requiredVotes };
  }

  return { accepted: false, totalVotes: proposal.votes.size, requiredVotes: proposal.requiredVotes };
}

/**
 * 应用提案（标记为已应用）
 */
export function applyProposal(proposalId: string): boolean {
  const proposal = ACTIVE_PROPOSALS.get(proposalId);
  if (!proposal || proposal.state !== 'accepted') return false;
  proposal.state = 'applied';
  proposal.resolvedAt = new Date().toISOString();
  return true;
}

/**
 * 查找文件的活跃提案
 */
function findActiveProposalForFile(filePath: string): ConsensusProposal | undefined {
  return Array.from(ACTIVE_PROPOSALS.values()).find(
    p => p.filePath === filePath && (p.state === 'proposed' || p.state === 'voting')
  );
}

/**
 * 获取冲突日志
 */
export function getConflictLog(): ConflictRecord[] {
  return [...CONFLICT_LOG];
}

/**
 * 获取所有活跃提案
 */
export function getActiveProposals(swarmId?: string): ConsensusProposal[] {
  let proposals = Array.from(ACTIVE_PROPOSALS.values());
  if (swarmId) {
    proposals = proposals.filter(p => p.swarmId === swarmId);
  }
  return proposals.filter(p => p.state === 'proposed' || p.state === 'voting');
}

/**
 * 清理过期提案（超过 30 分钟未解决）
 */
export function cleanupStaleProposals(): number {
  const now = Date.now();
  const staleThreshold = 30 * 60 * 1000;
  let cleaned = 0;

  for (const [id, proposal] of ACTIVE_PROPOSALS) {
    if (proposal.state === 'proposed' || proposal.state === 'voting') {
      const age = now - new Date(proposal.createdAt).getTime();
      if (age > staleThreshold) {
        proposal.state = 'rejected';
        proposal.resolvedAt = new Date().toISOString();
        cleaned++;
      }
    }
  }

  return cleaned;
}
