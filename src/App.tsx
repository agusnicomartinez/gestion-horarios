function App() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '0 auto' }}>
      <h1>Gestión de Horarios</h1>
      <p>
        Proyecto inicializado. La aplicación (login con DNI, panel del supervisor,
        panel del empleado, generación de cronograma) se implementa en la próxima iteración.
      </p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Antes de seguir, configurá Supabase con <code>supabase/schema.sql</code> y rellená{' '}
        <code>.env</code> con las credenciales del proyecto.
      </p>
    </main>
  )
}

export default App
