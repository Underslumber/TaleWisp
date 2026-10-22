/*
 * Focused geometry port from XMind's MIT-licensed xmind-viewer sources.
 * Copyright (c) 2019 XMind Ltd.
 * See LICENSE and NOTICE in this directory.
 *
 * This module keeps only the measured-bounds, bilateral branch placement and
 * horizontal curve rules used by the original viewer. TaleWisp supplies plain
 * node bounds and retains its own interaction, rendering and colors.
 */

export const XMindPADDING = 20;
export const XMindMIN_TOP_BOTTOM_SPACING = 80;
export const XMindMAX_TOP_BOTTOM_SPACING = 180;
export const XMindPARENT_TOPIC_THRESHOLD = 230;

/** Port of BaseMap._getWeight/calcRightSideCount (baseMap.ts). */
export function xmindRightSideCount(children, parentTopicHeight = 0) {
  const length = children.length;
  if (!length) return 0;
  const weight = child => child.bounds.height + XMindPADDING / 2 * 3;
  const threshold = 200 * (Math.log(length) + 1);
  const halfWeight = children.reduce((sum, child) => sum + weight(child), 0) / 2;
  let rightWeight = 0;
  for (let index = 0; index < length; index++) {
    const nextWeight = rightWeight + weight(children[index]);
    if (nextWeight >= halfWeight) {
      if (index === 0 && length === 2 && weight(children[0]) < threshold && weight(children[1]) < threshold) return 2;
      const previousIndex = index - 1;
      return previousIndex >= 0 && nextWeight - halfWeight > halfWeight - rightWeight ? index : index + 1;
    }
    rightWeight = nextWeight;
  }
  return length;
}

/**
 * Port of BaseMap.calcSidePos (baseMap.ts). `bounds` and `topicBounds` are
 * measured rectangles relative to each topic's center. Returns center positions
 * for the child topics on the requested side of the parent.
 */
export function xmindPlaceMainTopics(children, {
  direction,
  parentTopicBounds,
  spacingMajor,
  spacingMinor = 0,
  isUpToDown = false,
}) {
  if (!children.length || (direction !== 'left' && direction !== 'right')) return [];
  const parentHeight = parentTopicBounds.height;
  const topBottomSpacing = parentHeight > XMindPARENT_TOPIC_THRESHOLD
    ? Math.min(XMindMAX_TOP_BOTTOM_SPACING, parentHeight - XMindPARENT_TOPIC_THRESHOLD + XMindMIN_TOP_BOTTOM_SPACING)
    : XMindMIN_TOP_BOTTOM_SPACING;
  let remainingSpacing = topBottomSpacing;
  const relativeY = [0];
  for (let index = 1; index < children.length; index++) {
    const previous = children[index - 1], child = children[index];
    const previousTopicBottom = previous.topicBounds.y + previous.topicBounds.height;
    const childTopicTop = child.topicBounds.y;
    const nextY = Math.max(
      relativeY[index - 1] + previous.bounds.y + previous.bounds.height + spacingMinor - child.bounds.y,
      relativeY[index - 1] + previousTopicBottom + remainingSpacing / (children.length - index) - childTopicTop,
    );
    relativeY[index] = nextY;
    remainingSpacing -= nextY + childTopicTop - (relativeY[index - 1] + previousTopicBottom);
  }

  const first = children[0], last = children.at(-1);
  const firstAnchor = first.endAnchorY;
  const lastAnchor = last.endAnchorY;
  const parentRelativeY = (firstAnchor + relativeY[0] + lastAnchor + relativeY.at(-1)) / 2;
  const firstTopicY = first === last
    ? (isUpToDown ? -1 : 1) * topBottomSpacing / 2 - first.topicBounds.y - (isUpToDown ? first.topicBounds.height : 0)
    : -parentRelativeY;
  const parentLeft = -parentTopicBounds.width / 2;
  const parentRight = parentTopicBounds.width / 2;
  const sideX = direction === 'left' ? parentLeft - spacingMajor : parentRight + spacingMajor;

  return children.map((child, index) => ({
    x: direction === 'left'
      ? sideX - child.bounds.x - child.bounds.width + child.topicBounds.x + child.topicBounds.width / 2
      : sideX - child.bounds.x + child.topicBounds.x + child.topicBounds.width / 2,
    y: firstTopicY + relativeY[index] + child.topicBounds.y + child.topicBounds.height / 2,
  }));
}

/** Port of LeftAndRight.getChildrenSize/calcAttachedChildrenPosByDirection. */
export function xmindPlaceAttachedTopics(parent, children, direction, spacingMajor, spacingMinor = 0, lineWidth = 0) {
  if (!children.length) return [];
  const totalHeight = children.reduce((sum, child) => sum + child.bounds.height + spacingMinor + lineWidth, 0) - spacingMinor - lineWidth;
  let cursorY = -totalHeight / 2;
  const sideX = direction === 'right'
    ? parent.bounds.x + parent.bounds.width + spacingMajor
    : parent.bounds.x - spacingMajor;
  return children.map(child => {
    const point = direction === 'right'
      ? { x: sideX - child.bounds.x + child.topicBounds.x + child.topicBounds.width / 2, y: cursorY + child.bounds.height / 2 }
      : { x: sideX - child.bounds.x - child.bounds.width + child.topicBounds.x + child.topicBounds.width / 2, y: cursorY + child.bounds.height / 2 };
    cursorY += child.bounds.height + spacingMinor + lineWidth;
    return point;
  });
}

/** Port of brushes.curveHorizon (view/renderEngine/topicShape/brushes.ts). */
export function xmindCurveHorizon({ start, control, end }) {
  const dx = end.x - control.x;
  const controlX = dx / 5 + control.x;
  return `M ${start.x} ${start.y} L ${control.x} ${control.y} Q ${controlX} ${end.y} ${end.x} ${end.y}`;
}
