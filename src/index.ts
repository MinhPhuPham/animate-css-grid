import throttle from 'lodash/throttle'
import {
  linear,
  easeIn,
  easeOut,
  easeInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
} from '@popmotion/easing' ;
import { tween } from 'popmotion';
import sync from 'framesync';
import {
  BoundingClientRect,
  CachedPositionData,
  ChildBoundingClientRect,
  Coords,
  ItemPosition,
  PopmotionEasing,
  WrapGridArguments,
} from "./types";

const popmotionEasing: PopmotionEasing = {
  linear,
  easeIn,
  easeOut,
  easeInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  anticipate,
}

const DATASET_KEY = "animateGridId";

// in order to account for scroll, (which we're not listening for)
// always cache the item's position relative
// to the top and left of the grid container
const getGridAwareBoundingClientRect = (
  gridBoundingClientRect: BoundingClientRect,
  el: HTMLElement,
): BoundingClientRect => {
  const { top, left, width, height } = el.getBoundingClientRect();
  const rect = { top, left, width, height };
  rect.top -= gridBoundingClientRect.top;
  rect.left -= gridBoundingClientRect.left;
  // if an element is display:none it will return top: 0 and left:0
  // rather than saying it's still in the containing element
  // so we need to use Math.max to make sure the coordinates stay
  // within the container
  rect.top = Math.max(rect.top, 0);
  rect.left = Math.max(rect.left, 0);
  return rect;
};

// the function used during the tweening
const applyCoordTransform = (
  el: HTMLElement,
  { translateX, translateY, scaleX, scaleY }: Coords,
  { immediate }: { immediate?: boolean } = {},
): void => {
  const isFinished =
    translateX === 0 && translateY === 0 && scaleX === 1 && scaleY === 1;
  const styleEl = () => {
    el.style.transform = isFinished
      ? ""
      : `translateX(${translateX}px) translateY(${translateY}px) scaleX(${scaleX}) scaleY(${scaleY})`;
  };
  if (immediate) {
    styleEl();
  } else {
    sync.render(styleEl);
  }
  const firstChild = el.children[0] as HTMLElement;
  if (firstChild) {
    const styleChild = () => {
      firstChild.style.transform = isFinished
        ? ""
        : `scaleX(${1 / scaleX}) scaleY(${1 / scaleY})`;
    };
    if (immediate) {
      styleChild();
    } else {
      sync.render(styleChild);
    }
  }
};

// return a function that take a reference to a grid dom node and optional config
export const wrapGrid = (
  container: HTMLElement,
  { duration = 250, stagger = 0, easing = "easeInOut" }: WrapGridArguments = {},
) => {

  if (!popmotionEasing[easing]) {
    throw new Error(`${easing} is not a valid easing name`)
  }

  // all cached position data, and in-progress tween data, is stored here
  const cachedPositionData: CachedPositionData = {};
  // initially and after every transition, record element positions
  const recordPositions = (
    elements: HTMLCollectionOf<HTMLElement> | HTMLElement[],
  ) => {
    const gridBoundingClientRect = container.getBoundingClientRect();
    [...elements].forEach((el) => {
      if (typeof el.getBoundingClientRect !== "function") {
        return;
      }
      if (!el.dataset[DATASET_KEY]) {
        const animateGridId = `${Math.random()}`;
        el.dataset[DATASET_KEY] = animateGridId;
        cachedPositionData[animateGridId] = {} as ItemPosition
      }
      const animateGridId = el.dataset[DATASET_KEY] as string;
      const rect = getGridAwareBoundingClientRect(gridBoundingClientRect, el);
      cachedPositionData[animateGridId].rect = rect
      cachedPositionData[animateGridId].gridBoundingClientRect = gridBoundingClientRect
    });
  };
  recordPositions(container.children as HTMLCollectionOf<HTMLElement>);
  const throttledResizeListener = throttle(() => {
    recordPositions(container.children as HTMLCollectionOf<HTMLElement>);
  }, 250);
  window.addEventListener("resize", throttledResizeListener);
  const mutationCallback = (
    mutationsList: MutationRecord[] | "forceGridAnimation",
  ) => {
    if (mutationsList !== "forceGridAnimation") {
      // check if we care about the mutation
      const relevantMutationHappened = mutationsList.filter(
        (m: MutationRecord) =>
          m.attributeName === "class" ||
          m.addedNodes.length ||
          m.removedNodes.length,
      ).length;
      if (!relevantMutationHappened) {
        return;
      }
    }
    const gridBoundingClientRect = container.getBoundingClientRect();
    const childrenElements = [...container.children] as HTMLElement[];
    // stop current transitions and remove transforms on transitioning elements
    childrenElements
      .filter((el) => {
        const ItemPosition = cachedPositionData[el.dataset[DATASET_KEY] as string];
        if (ItemPosition && ItemPosition.stopTween) {
          ItemPosition.stopTween();
          delete ItemPosition.stopTween;
          return true;
        }
      })
      .forEach((el) => {
        el.style.transform = "";
        const firstChild = el.children[0] as HTMLElement;
        if (firstChild) {
          firstChild.style.transform = "";
        }
      });
    const animatedGridChildren = childrenElements
      .map((el) => ({
        childCoords:  {} as ChildBoundingClientRect,
        el,
        boundingClientRect: getGridAwareBoundingClientRect(
          gridBoundingClientRect,
          el,
        ),
      }))
      .filter(({ el, boundingClientRect }) => {
        const ItemPosition = cachedPositionData[el.dataset[DATASET_KEY] as string];
        // don't animate the initial appearance of elements,
        // just cache their position so they can be animated later
        if (!ItemPosition) {
          recordPositions([el]);
          return false;
        } else if (
          boundingClientRect.top === ItemPosition.rect.top &&
          boundingClientRect.left === ItemPosition.rect.left &&
          boundingClientRect.width === ItemPosition.rect.width &&
          boundingClientRect.height === ItemPosition.rect.height
        ) {
          // if it hasn't moved, dont animate it
          return false;
        }
        return true;
      });

    // having more than one child in the animated item is not supported
    animatedGridChildren.forEach(({ el }) => {
      if ([...el.children].length > 1) {
        throw new Error(
          "Make sure every grid item has a single container element surrounding its children",
        );
      }
    });

    animatedGridChildren
      // do this measurement first so as not to cause layout thrashing
      .map((data) => {
        const firstChild = data.el.children[0] as HTMLElement;
        // different transform origins give different effects. "50% 50%" is default
        if (firstChild) {
          data.childCoords = getGridAwareBoundingClientRect(
            gridBoundingClientRect,
            firstChild,
          );
        }
        return data;
      })
      .forEach(
        (
          {
            el,
            boundingClientRect: { top, left, width, height },
            childCoords: { top: childTop, left: childLeft },
          },
          i,
        ) => {
          const firstChild = el.children[0] as HTMLElement;
          const ItemPosition = cachedPositionData[el.dataset[DATASET_KEY] as string];
          const coords: Coords = {
            scaleX: ItemPosition.rect.width / width,
            scaleY: ItemPosition.rect.height / height,
            translateX: ItemPosition.rect.left - left,
            translateY: ItemPosition.rect.top - top,
          };

          el.style.transformOrigin = "0 0";
          if (firstChild && childLeft === left && childTop === top) {
            firstChild.style.transformOrigin = "0 0";
          }

          applyCoordTransform(el, coords, { immediate: true });
          // now start the animation
          const startAnimation = () => {
            const { stop } = tween({
              from: coords,
              to: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
              duration,
              ease: popmotionEasing[easing],
            }).start((transforms: Coords) => {
              applyCoordTransform(el, transforms);
              // this helps prevent layout thrashing
              sync.postRender(() => recordPositions([el]));
            });
            ItemPosition.stopTween = stop;
          };

          if (typeof stagger !== "number") {
            startAnimation();
          } else {
            const timeoutId = setTimeout(() => {
              sync.update(startAnimation);
            }, stagger * i);
            ItemPosition.stopTween = () => clearTimeout(timeoutId);
          }
        },
      );
  };
  const observer = new MutationObserver(mutationCallback);
  observer.observe(container, {
    childList: true,
    attributes: true,
    subtree: true,
    attributeFilter: ["class"],
  });
  const unwrapGrid = () => {
    window.removeEventListener("resize", throttledResizeListener);
    observer.disconnect();
  };
  const forceGridAnimation = () => mutationCallback("forceGridAnimation");
  return { unwrapGrid, forceGridAnimation };
};