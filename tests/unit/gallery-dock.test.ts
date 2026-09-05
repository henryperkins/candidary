// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { measureDockedExtent } from '../../src/features/gallery/gallery-dock';

function viewport(width: number, height: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: height });
}

function docked(className: string, geometry: { top: number; offsetTop: number; width: number; height: number }) {
  const element = document.createElement('div');
  element.className = className;
  element.style.position = 'fixed';
  element.getBoundingClientRect = () => ({
    x: 0, y: geometry.top, top: geometry.top, left: 0, right: geometry.width,
    bottom: geometry.top + geometry.height, width: geometry.width, height: geometry.height,
    toJSON: () => ({}),
  });
  Object.defineProperty(element, 'offsetTop', { configurable: true, value: geometry.offsetTop });
  return element;
}

describe('measureDockedExtent', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('reserves from the docked element’s laid-out top, not the transform it is animating through', () => {
    viewport(390, 844);
    const root = document.createElement('section');
    // The tray arrives on a 180ms translate from below. A client rect read during that frame puts
    // its top at the viewport's bottom edge; the offset is the position the layout gave it.
    root.append(docked('selection-tray', { top: 832, offsetTop: 606, width: 366, height: 226 }));
    document.body.append(root);

    expect(measureDockedExtent(root)).toBe(844 - 606);
  });

  it('reserves nothing for a corner card narrower than four fifths of the viewport', () => {
    viewport(1024, 800);
    const root = document.createElement('section');
    root.append(docked('selection-tray', { top: 600, offsetTop: 600, width: 470, height: 176 }));
    document.body.append(root);

    expect(measureDockedExtent(root)).toBe(0);
  });
});
