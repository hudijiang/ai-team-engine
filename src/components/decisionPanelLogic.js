export function getDecisionConfirmState({ selectedIdx, showCustom, customInput }) {
    const trimmedCustomInput = customInput.trim();
    const canResolveCustom = showCustom && !!trimmedCustomInput;
    const canResolveSelected = selectedIdx !== null && selectedIdx !== undefined;

    return {
        disabled: !canResolveCustom && !canResolveSelected,
        payload: canResolveCustom
            ? { proposalIndex: -1, customText: trimmedCustomInput }
            : canResolveSelected
                ? { proposalIndex: selectedIdx, customText: '' }
                : null,
    };
}

export default { getDecisionConfirmState };
