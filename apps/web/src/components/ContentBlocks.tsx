type ContentBlock = {
  type?: string;
  value?: unknown;
  url?: unknown;
  alt?: unknown;
};

export function ContentBlocks({ blocks }: { blocks: unknown }) {
  if (!Array.isArray(blocks)) return null;
  return <>
    {(blocks as ContentBlock[]).map((block, index) => {
      if (block?.type === 'image' && typeof block.url === 'string') {
        return <img className="content-block-image" key={`image-${index}`} src={block.url} alt={typeof block.alt === 'string' ? block.alt : ''} />;
      }
      if (block?.type === 'text' || block?.type === 'rich_text' || block?.type === 'math') {
        return <span key={`text-${index}`}>{String(block.value ?? '')}</span>;
      }
      return null;
    })}
  </>;
}
