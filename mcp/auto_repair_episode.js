export const AUTO_REPAIR_EPISODE_VERSION = '2.5.0-p1.4';

function workspaceFor(episode, map) {
  const name = String(map || '').toUpperCase();
  const workspace = episode.workspaces.get(name);
  if (!workspace) throw new Error(`Map ${name} is not part of this episode workspace`);
  return { name, workspace };
}

function applyOne(workspace, edit) {
  switch (edit.type) {
    case 'repair_clear_blocking':
      if (typeof workspace.repairClearBlocking !== 'function') throw new Error('P1.4 auto-repair layer is not installed');
      return workspace.repairClearBlocking(edit);
    case 'repair_set_linedef_special':
      if (typeof workspace.repairSetLinedefSpecial !== 'function') throw new Error('P1.4 auto-repair layer is not installed');
      return workspace.repairSetLinedefSpecial(edit);
    case 'set_sector_heights':
      return workspace.setSectorHeights(edit);
    case 'thing_add':
      if (typeof workspace.addThing !== 'function') throw new Error('P1 THINGS layer is not installed');
      return workspace.addThing(edit);
    case 'thing_move':
      if (typeof workspace.moveThing !== 'function') throw new Error('P1 THINGS layer is not installed');
      return workspace.moveThing(edit);
    default:
      throw new Error(`Unsupported P1.4 repair edit: ${edit.type}`);
  }
}

export function applyRepairPlan(episode, edits = []) {
  if (!episode.transaction) throw new Error('Begin an episode transaction before applying a P1.4 repair plan');
  if (!Array.isArray(edits) || !edits.length) throw new Error('Repair plan must contain at least one edit');
  if (edits.length > 8) throw new Error('P1.4 repair plan is limited to 8 edits per iteration');

  const results = [];
  try {
    for (let index = 0; index < edits.length; index++) {
      const edit = { ...edits[index] };
      delete edit.rationale;
      delete edit.sourceIssue;
      const { name, workspace } = workspaceFor(episode, edit.map);
      edit.map = name;
      const result = applyOne(workspace, edit);
      episode.transaction.touchedMaps.add(name);
      episode.transaction.edits.push(structuredClone(edit));
      results.push({ index, edit, result });
    }
    return { transaction: episode.summary().transaction, results };
  } catch (error) {
    const transactionId = episode.transaction?.id;
    if (episode.transaction) episode.rollbackTransaction();
    throw new Error(`P1.4 repair transaction ${transactionId || '<unknown>'} rolled back after edit failure: ${error?.message || error}`);
  }
}
