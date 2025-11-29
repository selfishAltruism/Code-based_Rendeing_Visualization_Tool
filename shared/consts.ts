export const SOURCE_INIT = `import React, { useState, useEffect, useRef } from 'react';

function ExampleComponent() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    console.log('effect', count);
    ref.current = document.body;
  }, [count]);

  return (
    <div ref={ref}>
      <button onClick={() => setCount((c) => c + 1)}>Click {count}</button>
    </div>
  );
}

export default ExampleComponent;
`;
