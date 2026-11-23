/** Keep unrelated cached exports and diagnostic objects out of a requested delivery. */
const aspectKeys = { '16:9': ['video16x9','thumbnail16x9'], '9:16': ['video9x16Shorts','thumbnail9x16'] };
export function requestedDeliveryFiles(files, aspects) {
  const known = new Set(Object.values(aspectKeys).flat());
  const allowed = new Set(aspects.flatMap(aspect => aspectKeys[aspect] || []));
  return Object.fromEntries(Object.entries(files).filter(([key,value]) => typeof value === 'string' && (!known.has(key) || allowed.has(key))));
}
export function mayUploadAspect(review, aspect) {
  return review?.approvedForUpload === true && review.requestedAspects?.includes(aspect) && review.bestCandidate?.aspects?.[aspect]?.ok === true;
}
