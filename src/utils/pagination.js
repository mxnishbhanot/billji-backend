export const wantsPagination = (query = {}) => Boolean(query.paginated || query.page || query.limit);

export const UNPAGINATED_LIST_CAP = 200;

export const getPagination = (query = {}, { defaultLimit = 10, maxLimit = 50 } = {}) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || defaultLimit), 1), maxLimit);
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

export const paginationMeta = ({ page, limit, total }) => ({
  page,
  limit,
  total,
  totalPages: Math.max(Math.ceil(total / limit), 1),
  hasMore: page * limit < total,
  nextPage: page * limit < total ? page + 1 : null
});

export const paginateQuery = async (query, countQuery, queryParams, options) => {
  const { page, limit, skip } = getPagination(queryParams, options);
  const [items, total] = await Promise.all([query.skip(skip).limit(limit), countQuery]);

  return {
    items,
    pagination: paginationMeta({ page, limit, total })
  };
};
